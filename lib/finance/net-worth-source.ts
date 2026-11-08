import type { SupabaseClient } from "@supabase/supabase-js";
import { allPages } from "@/lib/all-pages";
import { archiveDates, currentNetWorth, firstSyncedOn, loadScalableHistory, loadWealthEvents, netWorthSeries, valuationHistory, type NetWorthPoint } from "@/app/money/wealth/net-worth";
import { loadBalanceEvidence, resolveBalances } from "./balances";
import { calendarDate } from "./calendar";
import { loadTransferLegs } from "./own-transfers";
import { matchTransfers, transitOn, type BrokerTransfer } from "./transit";
import { loadWealthItems, wealthEvidence } from "./wealth";

// One source for net worth: every screen, the chat and the voice call read totals from here, so they can't disagree.

type Workspace = { id: string; timezone: string };

export async function loadScalableTransfers(db: SupabaseClient, workspaceId: string) {
  const [rows, connections] = await Promise.all([
    allPages<BrokerTransfer>((from, to) => db.from("scalable_transfers").select("provider_id, type, amount_minor::text, currency_code, occurred_at, on_date, status, is_cancellation, returns_provider_id, description").eq("workspace_id", workspaceId).order("provider_id").range(from, to) as never),
    db.from("scalable_connections").select("transfers_backfilled_at").eq("workspace_id", workspaceId).not("transfers_backfilled_at", "is", null).limit(1),
  ]);
  if (connections.error) throw new Error(connections.error.message);
  return { rows, complete: (connections.data ?? []).length > 0 };
}

/** Everything the calculation needs. A page that already holds some of it passes it in. */
export async function loadNetWorthEvidence(db: SupabaseClient, workspace: Workspace, given: { balances?: PromiseLike<Awaited<ReturnType<typeof loadBalanceEvidence>>>; items?: PromiseLike<Awaited<ReturnType<typeof loadWealthItems>>>; events?: PromiseLike<Awaited<ReturnType<typeof loadWealthEvents>>> } = {}) {
  const [balances, items, events, scalable, transfers, legs] = await Promise.all([
    given.balances ?? loadBalanceEvidence(db, workspace.id), given.items ?? loadWealthItems(db, workspace.id, true), given.events ?? loadWealthEvents(db, workspace.id),
    loadScalableHistory(db, workspace.id), loadScalableTransfers(db, workspace.id), loadTransferLegs(db, workspace.id),
  ]);
  return { timeZone: workspace.timezone, balances, items, events, scalable, transfers, legs };
}
export type NetWorthEvidence = Awaited<ReturnType<typeof loadNetWorthEvidence>>;

/** Which money counts today and on past days, worked out once from the evidence. */
export function netWorthModel(evidence: NetWorthEvidence) {
  const { balances, items, events, scalable, transfers, legs, timeZone } = evidence;
  const today = calendarDate(balances.asOf, timeZone);
  const valuations = valuationHistory(events, items, timeZone);
  const firstReal = firstSyncedOn(valuations, scalable.knownIds);
  // Real reads of Scalable only: the current row isn't a read, its events are.
  const reads = valuations.filter(row => scalable.knownIds.has(row.item_id) && row.created_at < "9999");
  const coveredFrom = balances.ledger.reduce<string | null>((first, row) => row.status === "posted" && (first === null || row.posted_on < first) ? row.posted_on : first, null);
  const { windows, unresolved } = matchTransfers({ transfers: transfers.rows, legs, firstReal, reads, complete: transfers.complete, coveredFrom });
  const accounts = resolveBalances(balances.accounts, balances.snapshots, balances.ledger, balances.asOf, timeZone).filter(account => !account.archived_at);
  const active = items.filter(item => !item.removed_at);
  const kinds = new Map(items.map(item => [item.id, item.kind]));
  const dated = wealthEvidence(active, today);
  const calculated = { rows: scalable.rows, before: firstReal };
  /** Past days and today from the same inputs. Today's point is the headline's own, so the graph ends on the number above it. */
  const points = (dates: string[]): NetWorthPoint[] => netWorthSeries({ dates: dates.filter(date => date !== today), timeZone, accountIds: new Set(balances.accounts.map(account => account.id)), archivedOn: archiveDates(balances.accounts, timeZone),
    snapshots: balances.snapshots, ledger: balances.ledger, valuations, calculated, transit: windows }).concat(dates.includes(today) ? [now] : []).sort((a, b) => a.date.localeCompare(b.date));
  // Every side of a window has landed by today, except a broker side no read has seen yet: that money is still the owner's.
  const now = currentNetWorth(today, accounts, dated.included.map(valuation => ({ ...valuation, debt: kinds.get(valuation.id) === "debt" })), transitOn(windows, today));
  // Money moved on the first real day is already in that value, so the comparison with the day before allows for it.
  const movedOnBoundaryMinor = transfers.rows.filter(row => row.on_date === firstReal && row.status === "SETTLED" && !row.is_cancellation).reduce((sum, row) => sum + BigInt(row.amount_minor), 0n);
  return { today, now, points, accounts, active, dated, kinds, valuations, firstReal, calculated, windows, unresolved, movedOnBoundaryMinor };
}
export type NetWorthModel = ReturnType<typeof netWorthModel>;
