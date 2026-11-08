import type { SupabaseClient } from "@supabase/supabase-js";
import { allPages } from "@/lib/all-pages";
import { archiveDates, currentNetWorth, dayRange, firstSyncedOn, loadScalableHistory, loadWealthEvents, monthEnds, netWorth, netWorthSeries, valuationHistory, type NetWorthPoint } from "@/app/money/wealth/net-worth";
import { loadBalanceEvidence, resolveBalances } from "./balances";
import { calendarDate } from "./calendar";
import { z } from "zod";
import { describeMissingInputs, formatMoney } from "./format";
import { convertFx } from "./fx";
import { parseIouName } from "./iou";
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

  /**
   * This month's change, split so spending and markets stay apart and something newly added isn't a gain.
   * `changeMinor` excludes what's newly added; the total still counts it. Moving your own money is neither.
   */
  const monthSplit = (currency: string, base = monthEnds(today, 1)[0]) => {
    const [basePoint] = points([base]);
    if (!basePoint?.known) return null;
    const totalChangeMinor = (netWorth(now).get(currency) ?? 0n) - (netWorth(basePoint).get(currency) ?? 0n);
    const isLoan = (name: string) => parseIouName(name) !== null;
    const portfolioBefore = !!firstReal && firstReal > base && calculated.rows.some(row => row.on_date === base);
    const newCovered = (id: string) => portfolioBefore && scalable.knownIds.has(id);
    // Loans move with the bank money that paid them, so they're never "new" and belong with money in and out.
    const named = new Map(items.map(item => [item.id, item.name]));
    const states = valuations.filter(row => row.currency_code === currency && !row.removed && !isLoan(String((row as { name?: string }).name ?? named.get(row.item_id) ?? "")));
    const valueOn = (date: string, rows: typeof valuations) => {
      const pick = new Map<string, typeof valuations[number]>();
      for (const row of rows) { if (row.as_of > date) continue; const prior = pick.get(row.item_id); if (!prior || row.as_of > prior.as_of || (row.as_of === prior.as_of && row.created_at >= prior.created_at)) pick.set(row.item_id, row); }
      return pick;
    };
    const allStates = valuations.filter(row => row.currency_code === currency && !isLoan(String((row as { name?: string }).name ?? named.get(row.item_id) ?? "")));
    const counted = (date: string) => [...valueOn(date, allStates).values()].filter(row => !row.removed && !row.linked_account_id);
    const investing = (date: string) => counted(date).filter(row => row.kind !== "debt").reduce((sum, row) => sum + BigInt(row.amount_minor), 0n)
      + (firstReal && date < firstReal ? BigInt(calculated.rows.find(row => row.on_date === date && row.currency_code === currency)?.total_minor ?? "0") : 0n);
    let newlyAddedMinor = 0n, newInvestingMinor = 0n;
    for (const row of counted(today)) {
      const first = states.filter(state => state.item_id === row.item_id && !state.linked_account_id).reduce<typeof states[number] | null>((earliest, state) => !earliest || state.as_of < earliest.as_of || (state.as_of === earliest.as_of && state.created_at < earliest.created_at) ? state : earliest, null);
      if (!first || first.as_of <= base || newCovered(row.item_id)) continue;
      newlyAddedMinor += BigInt(first.amount_minor);
      if (row.kind !== "debt") newInvestingMinor += BigInt(first.amount_minor);
    }
    const days = dayRange(base, today).slice(1);
    const accountPoints = points(days);
    const atBase = basePoint.accountValues ?? new Map<string, bigint>();
    for (const account of balances.accounts) {
      if (account.currency_code !== currency || atBase.has(account.id)) continue;
      const first = accountPoints.find(point => point.accountValues?.has(account.id));
      if (first) newlyAddedMinor += first.accountValues!.get(account.id)!;
      else if (account.archived_at === null || account.archived_at === undefined) { const live = accounts.find(item => item.id === account.id)?.balance.amount_minor; if (live) newlyAddedMinor += BigInt(live); }
    }
    const movedIntoBroker = transfers.rows.filter(row => row.currency_code === currency && row.status === "SETTLED" && !row.is_cancellation && row.on_date > base && row.on_date <= today).reduce((sum, row) => sum + BigInt(row.amount_minor), 0n);
    const investmentsMinor = investing(today) - investing(base) - movedIntoBroker - newInvestingMinor;
    const changeMinor = totalChangeMinor - newlyAddedMinor;
    return { base, baseMinor: netWorth(basePoint).get(currency) ?? 0n, totalChangeMinor, changeMinor, moneyMinor: changeMinor - investmentsMinor, investmentsMinor, newlyAddedMinor };
  };
  return { timeZone, today, now, points, monthSplit, accounts, active, dated, kinds, valuations, firstReal, calculated, windows, unresolved, movedOnBoundaryMinor };
}
export type NetWorthModel = ReturnType<typeof netWorthModel>;

type Rate = { from_currency: string; rate_text: string; rate_date: string; source: string };

export async function loadFxRates(db: SupabaseClient, workspaceId: string, displayCurrency: string): Promise<Rate[]> {
  const { data, error } = await db.from("fx_rates").select("from_currency, to_currency, rate_text, rate_date, source").eq("workspace_id", workspaceId).eq("to_currency", displayCurrency).order("rate_date", { ascending: false }).order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Rate[];
}

/** Today's total in one currency: dated balances and values, each converted with the latest rate on or before its date. An input that can't be converted is left out and named. */
export function convertedNetWorth(model: NetWorthModel, rates: Rate[], displayCurrency: string) {
  const missingInputs: string[] = [];
  const parts = { cash: 0n, assets: 0n, debts: 0n, transit: 0n };
  let totalMinor = 0n, convertedCount = 0;
  const add = (amountMinor: bigint, from: string, asOf: string, source: string, name: string, part: keyof typeof parts) => {
    const rate = from === displayCurrency ? undefined : rates.find(row => row.from_currency === from && String(row.rate_date).slice(0, 10) <= asOf);
    try {
      const result = convertFx({ amountMinor, from, to: displayCurrency, rate: rate?.rate_text, source: rate?.source ?? source, date: rate ? String(rate.rate_date).slice(0, 10) : asOf });
      if (result.status === "available") { totalMinor += result.converted.amountMinor; convertedCount += 1; parts[part] += result.converted.amountMinor; }
      else missingInputs.push(...result.missingInputs.map(input => `${input} for ${name}`));
    } catch { missingInputs.push(`rate:${from}->${displayCurrency} for ${name}`); }
  };
  for (const account of model.accounts) {
    const { balance } = account;
    if (balance.amount_minor === null) { missingInputs.push(`balance:${account.name}`); continue; }
    add(BigInt(balance.amount_minor), balance.currency_code, calendarDate(balance.as_of!, model.timeZone), balance.provenance || "balance", account.name, "cash");
  }
  missingInputs.push(...model.dated.missingInputs);
  for (const valuation of model.dated.included) add(valuation.amountMinor, valuation.currencyCode, valuation.asOf, valuation.provenance, valuation.name, model.kinds.get(valuation.id) === "debt" ? "debts" : "assets");
  for (const [currency, amount] of model.now.transit) add(amount, currency, model.today, "own transfer", "Money between your accounts", "transit");
  return { totalMinor, parts, missingInputs, convertedCount };
}

export const netWorthInput = z.object({
  date: z.iso.date().optional().describe("The day to read; defaults to today"),
  days: z.number().int().min(1).max(366).optional().describe("Also return each of the last N days, for a trend or chart"),
}).strict();

type Reader = { supabase: SupabaseClient; workspace: { id: string; timezone: string; display_currency: string; locale: string } };

/**
 * Net worth as chat, the voice call and artifacts read it: the same calculation as Home and Wealth, for today or a past date, with what was
 * left out and how fresh each input is. Past days are in each currency as recorded, without conversion (issue #158).
 */
export async function readNetWorth({ supabase, workspace }: Reader, input: unknown) {
  const { date, days } = netWorthInput.parse(input);
  const [evidence, rates] = await Promise.all([loadNetWorthEvidence(supabase, workspace), loadFxRates(supabase, workspace.id, workspace.display_currency)]);
  const model = netWorthModel(evidence);
  const money = (minor: bigint | string, currency = workspace.display_currency) => formatMoney(minor, currency, workspace.locale);
  const on = date ?? model.today;
  if (on > model.today) throw new Error("That date is in the future");
  const freshness = { accounts: model.accounts.map(account => ({ name: account.name, balanceAsOf: account.balance.as_of, status: account.balance.status, warnings: account.balance.warnings })),
    valuesNotFromToday: model.dated.outdated.map(row => ({ name: row.name, asOf: row.asOf })) };
  const trend = days ? model.points(dayRange(new Date(Date.parse(`${model.today}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10), model.today)).filter(point => point.known)
    .map(point => ({ date: point.date, amountMinor: (netWorth(point).get(workspace.display_currency) ?? 0n).toString(), amountFormatted: money(netWorth(point).get(workspace.display_currency) ?? 0n), ...(point.uncertain.length ? { notProven: point.uncertain } : {}) })) : undefined;
  const unresolvedTransfers = model.unresolved.map(item => ({ date: item.date, label: item.label, amountFormatted: money(item.amountMinor, item.currencyCode), reason: item.reason }));
  const link = "/money/wealth";
  if (on === model.today) {
    const total = convertedNetWorth(model, rates, workspace.display_currency);
    const split = model.monthSplit(workspace.display_currency);
    const names = new Map(model.active.map(item => [item.id, item.name]));
    return { date: on, currencyCode: workspace.display_currency, amountMinor: total.totalMinor.toString(), amountFormatted: money(total.totalMinor),
      parts: { accountsFormatted: money(total.parts.cash), investmentsAndAssetsFormatted: money(total.parts.assets), debtsFormatted: money(total.parts.debts), ...(total.parts.transit ? { betweenYourAccountsFormatted: money(total.parts.transit) } : {}) },
      leftOut: describeMissingInputs(total.missingInputs, names), freshness, unresolvedTransfers, link,
      ...(split ? { thisMonth: { changeFormatted: money(split.changeMinor), moneyInAndOutFormatted: money(split.moneyMinor), investmentsFormatted: money(split.investmentsMinor), newlyAddedFormatted: money(split.newlyAddedMinor), note: "The change excludes what's newly added this month; the total includes it." } } : {}),
      ...(trend ? { trend } : {}) };
  }
  const [point] = model.points([on]);
  if (!point.known) return { date: on, known: false, note: "Nothing is on record that far back: the history starts where account data starts.", link, ...(trend ? { trend } : {}) };
  const totals = netWorth(point);
  return { date: on, known: true, currencyCode: workspace.display_currency, amountMinor: (totals.get(workspace.display_currency) ?? 0n).toString(), amountFormatted: money(totals.get(workspace.display_currency) ?? 0n),
    otherCurrencies: [...totals].filter(([currency]) => currency !== workspace.display_currency).map(([currency, amount]) => ({ currencyCode: currency, amountFormatted: money(amount, currency) })),
    parts: { accountsFormatted: money(point.accounts.get(workspace.display_currency) ?? 0n), investmentsAndAssetsFormatted: money(point.assets.get(workspace.display_currency) ?? 0n), debtsFormatted: money(point.debts.get(workspace.display_currency) ?? 0n) },
    ...(model.firstReal && on < model.firstReal ? { calculatedPortfolio: "Scalable's value on this day is calculated from its transactions and past prices." } : {}),
    ...(point.uncertain.length ? { notProven: point.uncertain } : {}), unresolvedTransfers, link, ...(trend ? { trend } : {}) };
}
