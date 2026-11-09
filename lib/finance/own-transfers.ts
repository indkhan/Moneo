import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { calendarDate } from "@/lib/finance/calendar";
import { formatMoney } from "@/lib/finance/format";
import { loadWorkspaceSettings } from "@/lib/settings";
import { closingMovedTo } from "./account-closing";
import type { BankLeg } from "./transit";

// Money moved between the owner's own accounts is a transfer, never income or spending.
// Detection is deterministic and IBAN-only: a row's counterparty IBAN is one of the owner's
// own accounts. Every decision goes through the audited link RPCs, so each one can be undone.

export const MATCH_DAYS = 3;
// A closing row says which account the money went to, and it can be archived well after the bank's row arrived.
const CLOSING_MATCH_DAYS = 30;
const IBAN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$/;

export function normalizeIban(value: string) {
  const iban = value.replace(/\s/g, "").toUpperCase();
  return IBAN.test(iban) ? iban : null;
}

/** Every IBAN-shaped value in an original source row (counterparty columns differ per bank). */
export function sourceIbans(row: unknown) {
  if (!row || typeof row !== "object") return [];
  return Object.values(row).flatMap(value => typeof value === "string" ? [normalizeIban(value)].filter((iban): iban is string => Boolean(iban)) : []);
}

export type TransferCandidate = {
  id: string; version: number; accountId: string; postedOn: string; amountMinor: bigint; currencyCode: string;
  reviewReasons: string[]; ibans: string[]; text?: string; counterparty?: string; transferId?: string | null;
  /** The account a closing row says this money went to. */
  closingTo?: string;
};

// Without an IBAN, only the bank's own wording proves own money: a cash machine, or Scalable Capital
// once the owner connected Scalable (their withdrawals arrive without the broker's IBAN).
const CASH = /\b(bargeldauszahlung|bargeldeinzahlung|geldautomat|cash withdrawal|atm withdrawal|cash deposit)\b/i;
const SCALABLE = /\bscalable capital\b/i, SCALABLE_LABEL = /\bscalable\b/i;
export type NamedAccount = "cash" | "scalable";
export const NAMED_LABELS: Record<NamedAccount, string> = { cash: "Cash", scalable: "Scalable Capital" };
export type OwnAccounts = { tracked: Map<string, string>; untracked: Map<string, string> }; // IBAN → account id / identifier id

const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

/** Every posted leg in the workspace, so a lone leg can tell whether its other side exists. */
export type Leg = Pick<TransferCandidate, "id" | "accountId" | "postedOn" | "amountMinor" | "currencyCode">;

export function findOwnTransfers(rows: TransferCandidate[], own: OwnAccounts, legs: Leg[] = rows, options: { scalable?: boolean } = {}) {
  // The posting account's own IBAN often appears in its row too; only the other side counts.
  const counterparts = (row: TransferCandidate) => row.ibans.filter(iban => own.tracked.get(iban) !== row.accountId);
  const points = (row: TransferCandidate, accountId: string) => row.closingTo === accountId || counterparts(row).some(iban => own.tracked.get(iban) === accountId);
  const matches = (out: TransferCandidate, into: TransferCandidate) => out.amountMinor < 0n && into.amountMinor === -out.amountMinor
    && out.currencyCode === into.currencyCode && out.accountId !== into.accountId && days(out.postedOn, into.postedOn) <= (out.closingTo || into.closingTo ? CLOSING_MATCH_DAYS : MATCH_DAYS);
  const used = new Set<string>();
  const pairs: { outId: string; inId: string }[] = [];
  const outs = rows.filter(row => row.amountMinor < 0n), ins = rows.filter(row => row.amountMinor > 0n);
  const take = (out: TransferCandidate, into: TransferCandidate) => { used.add(out.id); used.add(into.id); pairs.push({ outId: out.id, inId: into.id }); };

  // IBAN-proven pairs first, closest date wins.
  for (const out of outs) {
    const proven = ins.filter(into => !used.has(into.id) && matches(out, into) && (points(out, into.accountId) || points(into, out.accountId)))
      .sort((a, b) => days(out.postedOn, a.postedOn) - days(out.postedOn, b.postedOn) || a.id.localeCompare(b.id));
    if (!used.has(out.id) && proven[0]) take(out, proven[0]);
  }
  // A leg whose other side is missing: the counterparty is an own account, and no opposite
  // leg exists in that account within the window. Untracked accounts are named by identifier;
  // tracked accounts by IBAN.
  const unpaired = (row: TransferCandidate, accountId: string) => !legs.some(other => other.id !== row.id && other.accountId === accountId
    && other.currencyCode === row.currencyCode && other.amountMinor === -row.amountMinor && days(row.postedOn, other.postedOn) <= MATCH_DAYS);
  const single = rows.flatMap((row): { transactionId: string; identifierId?: string; iban?: string }[] => {
    if (used.has(row.id)) return [];
    const identifierId = counterparts(row).map(iban => own.untracked.get(iban)).find(Boolean);
    if (identifierId) return [{ transactionId: row.id, identifierId }];
    const iban = counterparts(row).find(item => own.tracked.has(item));
    const accountId = iban ? own.tracked.get(iban) : undefined;
    return iban && accountId && unpaired(row, accountId) ? [{ transactionId: row.id, iban }] : [];
  });
  const marked = new Set(single.map(item => item.transactionId));
  const named = rows.flatMap((row): { transactionId: string; account: NamedAccount }[] => {
    if (used.has(row.id) || marked.has(row.id) || counterparts(row).some(iban => own.tracked.has(iban) || own.untracked.has(iban))) return [];
    if (CASH.test(row.text ?? "")) return [{ transactionId: row.id, account: "cash" }];
    if (options.scalable && SCALABLE.test(`${row.counterparty ?? ""} ${row.text ?? ""}`)) return [{ transactionId: row.id, account: "scalable" }];
    return [];
  });
  return { pairs, single, named };
}

/**
 * Recent cash machine withdrawals with no other side yet. Until the owner accepts a card, one counts as money that left.
 * Older ones aren't asked about: that cash has most likely been spent, and the owner can set a Cash balance any time.
 */
export const CASH_CARD_DAYS = 30;
export function cashWithdrawals<T extends Pick<TransferCandidate, "id" | "postedOn" | "amountMinor" | "text" | "transferId">>(rows: T[], today: string, answered = new Set<string>()) {
  return rows.filter(row => row.amountMinor < 0n && !row.transferId && CASH.test(row.text ?? "") && !answered.has(row.id) && days(row.postedOn, today) <= CASH_CARD_DAYS);
}

const nameKey = (name: string) => name.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Rows from a name the owner already sent money under to one of their own IBANs (their name on an old or
 * untracked account). A name alone is weak evidence, so these are only ever suggestions for the owner to accept.
 * `seen` are rows that already prove an own account (including linked transfers); `answered` already have a card.
 */
export function ownNameSuggestions(rows: TransferCandidate[], seen: TransferCandidate[], own: OwnAccounts, answered = new Set<string>()) {
  const names = new Map<string, string>();
  for (const row of seen) {
    const other = row.ibans.filter(iban => own.tracked.get(iban) !== row.accountId);
    if (row.counterparty?.trim() && other.some(iban => own.tracked.has(iban) || own.untracked.has(iban))) names.set(nameKey(row.counterparty), row.counterparty.trim());
  }
  // A bank can put the holder's own name on a payment with no real other side (Revolut card refunds);
  // a transfer the owner made names them in the description too.
  return rows.flatMap(row => {
    const name = row.counterparty ? names.get(nameKey(row.counterparty)) : undefined;
    return name && !answered.has(row.id) && nameKey(row.text ?? "").includes(nameKey(name)) ? [{ transactionId: row.id, name }] : [];
  });
}

const PAGE = 1000, MAX_ROWS = 5000;

export async function loadOwnAccounts(db: SupabaseClient, workspaceId: string): Promise<OwnAccounts> {
  const [identifiers, bank, accounts] = await Promise.all([
    db.from("own_account_identifiers").select("id, account_id, iban").eq("workspace_id", workspaceId),
    db.from("bank_connection_accounts").select("iban, account_name, currency_code").eq("workspace_id", workspaceId).not("iban", "is", null),
    db.from("accounts").select("id, name, currency_code").eq("workspace_id", workspaceId),
  ]);
  for (const result of [identifiers, bank, accounts]) if (result.error) throw new Error(result.error.message);
  const tracked = new Map<string, string>(), untracked = new Map<string, string>();
  // A bank sync imports into the account with the bank's name and currency (see bankAccountNames).
  for (const row of bank.data ?? []) {
    const account = accounts.data?.find(item => item.name === row.account_name && item.currency_code === row.currency_code);
    const iban = normalizeIban(row.iban ?? "");
    if (account && iban) tracked.set(iban, account.id);
  }
  for (const row of identifiers.data ?? []) {
    if (row.account_id) tracked.set(row.iban, row.account_id); else untracked.set(row.iban, row.id);
  }
  return { tracked, untracked };
}

type Row = { id: string; version: number; account_id: string; posted_on: string; amount_minor: string; currency_code: string; review_reasons: string[] | null; description: string; transfer_id: string | null;
  transaction_sources: { source_transactions: { original_row: unknown } | null }[] | null };

/** The counterparty name a bank sync stores on its original row; other imports leave it out. */
const counterpartyOf = (row: unknown) => {
  const value = row && typeof row === "object" ? (row as { counterparty?: unknown }).counterparty : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

async function loadRows(db: SupabaseClient, workspaceId: string, kind: "ordinary" | "transfer") {
  const rows: TransferCandidate[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    let query = db.from("transactions")
      .select("id, version, account_id, posted_on, amount_minor::text, currency_code, review_reasons, description, transfer_id, transaction_sources(source_transactions(original_row))")
      .eq("workspace_id", workspaceId).eq("status", "posted").eq("kind", kind);
    if (kind === "ordinary") query = query.is("transfer_id", null).is("refund_of_id", null);
    const { data, error } = await query.order("posted_on", { ascending: false }).order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as unknown as Row[]) {
      const reviewReasons = row.review_reasons ?? [];
      if (kind === "ordinary" && reviewReasons.some(reason => reason !== "source_transfer")) continue;
      const originals = (row.transaction_sources ?? []).map(source => source.source_transactions?.original_row);
      rows.push({ id: row.id, version: row.version, accountId: row.account_id, postedOn: row.posted_on, amountMinor: BigInt(row.amount_minor),
        currencyCode: row.currency_code, reviewReasons, ibans: [...new Set(originals.flatMap(sourceIbans))], text: row.description, counterparty: originals.map(counterpartyOf).find(Boolean), transferId: row.transfer_id });
    }
    if ((data ?? []).length < PAGE) break;
  }
  return rows;
}

export const loadTransferCandidates = (db: SupabaseClient, workspaceId: string) => loadRows(db, workspaceId, "ordinary");

/** Own-transfer rows as sides of a transfer: what proves the broker is the other side, and whether a tracked account of the owner's is. */
export async function loadTransferLegs(db: SupabaseClient, workspaceId: string): Promise<BankLeg[]> {
  const [rows, own, identifiers] = await Promise.all([loadRows(db, workspaceId, "transfer"), loadOwnAccounts(db, workspaceId),
    db.from("own_account_identifiers").select("iban, label").eq("workspace_id", workspaceId)]);
  if (identifiers.error) throw new Error(identifiers.error.message);
  const brokerIbans = new Set((identifiers.data ?? []).filter(row => SCALABLE_LABEL.test(row.label)).map(row => row.iban as string));
  return rows.map(row => ({ id: row.id, accountId: row.accountId, amountMinor: row.amountMinor, currencyCode: row.currencyCode, postedOn: row.postedOn, transferId: row.transferId ?? null, text: row.text,
    provesBroker: row.ibans.some(iban => brokerIbans.has(iban)) || SCALABLE.test(`${row.counterparty ?? ""} ${row.text ?? ""}`),
    ownAccount: row.ibans.some(iban => own.tracked.has(iban) && own.tracked.get(iban) !== row.accountId) }));
}

/** Every posted leg, whatever its review state, so a lone leg can see whether its other side exists. */
async function loadLegs(db: SupabaseClient, workspaceId: string): Promise<Leg[]> {
  const legs: Leg[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await db.from("transactions")
      .select("id, account_id, posted_on, amount_minor::text, currency_code")
      .eq("workspace_id", workspaceId).eq("status", "posted").order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) legs.push({ id: row.id, accountId: row.account_id, postedOn: row.posted_on, amountMinor: BigInt(row.amount_minor), currencyCode: row.currency_code });
    if ((data ?? []).length < PAGE) break;
  }
  return legs;
}

export const ownTransferPayloadSchema = z.object({ transactionId: z.uuid(), name: z.string().trim().min(1).max(120) }).strict();

/** Raises one "your own money?" card per row, once: a declined card is never raised again. */
async function proposeOwnNames(db: SupabaseClient, workspaceId: string, rows: TransferCandidate[], seen: TransferCandidate[], own: OwnAccounts) {
  const known = await db.from("agent_proposals").select("conflict_key").eq("workspace_id", workspaceId).is("run_id", null).eq("kind", "own_transfer").limit(5000);
  if (known.error) throw new Error(known.error.message);
  const answered = new Set((known.data ?? []).map(row => String(row.conflict_key).replace(/^own_transfer:/, "")));
  const found = ownNameSuggestions(rows, seen, own, answered);
  if (!found.length) return 0;
  const { locale } = await loadWorkspaceSettings(db, workspaceId);
  const byId = new Map(rows.map(row => [row.id, row]));
  const cards = found.map(({ transactionId, name }) => {
    const row = byId.get(transactionId)!, money = formatMoney(row.amountMinor < 0n ? -row.amountMinor : row.amountMinor, row.currencyCode, locale);
    return { workspace_id: workspaceId, agent: "chat", kind: "own_transfer", conflict_key: `own_transfer:${transactionId}`, confidence: 70,
      title: (row.amountMinor < 0n ? `${money} to ${name}: your own account?` : `${money} from ${name}: your own account?`).slice(0, 200),
      detail: `You sent money under the name ${name} to one of your own accounts before. If this is yours too, it moves to transfers and stops counting as ${row.amountMinor < 0n ? "spending" : "income"}.`,
      evidence: { facts: [], transactions: [{ id: row.id, date: row.postedOn, description: row.text ?? "", amountMinor: row.amountMinor.toString(), currency: row.currencyCode }], links: [] },
      payload: ownTransferPayloadSchema.parse({ transactionId, name }) };
  });
  const { data, error } = await db.from("agent_proposals").insert(cards).select("id");
  // A concurrent sync raised the same card first.
  if (error && error.code !== "23505") throw new Error(error.message);
  return data?.length ?? 0;
}

/** Raises one "add it to your Cash account?" card per recent withdrawal, once: a declined card is never raised again. */
async function proposeCashWithdrawals(db: SupabaseClient, workspaceId: string, rows: TransferCandidate[]) {
  const { locale, timezone } = await loadWorkspaceSettings(db, workspaceId);
  const known = await db.from("agent_proposals").select("conflict_key").eq("workspace_id", workspaceId).is("run_id", null).eq("kind", "cash_withdrawal").limit(5000);
  if (known.error) throw new Error(known.error.message);
  const answered = new Set((known.data ?? []).map(row => String(row.conflict_key).replace(/^cash_withdrawal:/, "")));
  const found = cashWithdrawals(rows, calendarDate(new Date(), timezone), answered);
  if (!found.length) return 0;
  const cards = found.map(row => {
    const amount = -row.amountMinor, money = formatMoney(amount, row.currencyCode, locale);
    return { workspace_id: workspaceId, agent: "chat", kind: "cash_withdrawal", conflict_key: `cash_withdrawal:${row.id}`, confidence: 90,
      title: `${money} from a cash machine: add it to your Cash account?`.slice(0, 200),
      detail: "Until you add it, it counts as money that left. Once it's in Cash, your net worth stays the same; after spending, update the balance whenever you like.",
      evidence: { facts: [], transactions: [{ id: row.id, date: row.postedOn, description: row.text ?? "", amountMinor: row.amountMinor.toString(), currency: row.currencyCode }], links: [] },
      payload: { transactionId: row.id, amountMinor: amount.toString(), currencyCode: row.currencyCode, date: row.postedOn } };
  });
  const { data, error } = await db.from("agent_proposals").insert(cards).select("id");
  if (error && error.code !== "23505") throw new Error(error.message);
  return data?.length ?? 0;
}

/** Find and link transfers between the owner's accounts. The service role acts for the owner. */
export async function linkOwnTransfers(db: SupabaseClient, workspaceId: string) {
  const [own, rows, legs, transfers, scalable] = await Promise.all([loadOwnAccounts(db, workspaceId), loadTransferCandidates(db, workspaceId), loadLegs(db, workspaceId),
    loadRows(db, workspaceId, "transfer"), db.from("scalable_connections").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "active")]);
  if (scalable.error) throw new Error(scalable.error.message);
  const { data: accounts, error: accountsError } = await db.from("accounts").select("id, name, currency_code").eq("workspace_id", workspaceId);
  if (accountsError) throw new Error(accountsError.message);
  for (const row of rows) { const name = closingMovedTo(row.text); if (name) row.closingTo = accounts?.find(account => account.name === name && account.currency_code === row.currencyCode)?.id; }
  const { pairs, single, named } = findOwnTransfers(rows, own, legs, { scalable: (scalable.count ?? 0) > 0 });
  const byId = new Map(rows.map(row => [row.id, row]));
  let linked = 0, marked = 0, skipped = 0;
  for (const pair of pairs) {
    const out = byId.get(pair.outId)!, into = byId.get(pair.inId)!;
    // The RPC rejects pairs it can't prove (e.g. a documented fee); those stay for manual review.
    const { error } = await db.rpc("link_transactions", { p_operation: "transfer", p_primary_id: out.id, p_expected_version: out.version,
      p_other_id: into.id, p_other_version: into.version, p_fx_rate_id: null, p_fees: [], p_request_id: randomUUID() });
    if (error) skipped++; else linked++;
  }
  for (const item of single) {
    const expectedVersion = byId.get(item.transactionId)!.version;
    const { error } = item.identifierId
      ? await db.rpc("mark_own_account_transfer", { p_transaction_id: item.transactionId, p_expected_version: expectedVersion, p_identifier_id: item.identifierId })
      : await db.rpc("mark_own_iban_transfer", { p_transaction_id: item.transactionId, p_expected_version: expectedVersion, p_iban: item.iban });
    if (error) skipped++; else marked++;
  }
  for (const item of named) {
    const { error } = await db.rpc("mark_own_named_transfer", { p_transaction_id: item.transactionId, p_expected_version: byId.get(item.transactionId)!.version, p_kind: item.account });
    if (error) skipped++; else marked++;
  }
  const handled = new Set([...pairs.flatMap(pair => [pair.outId, pair.inId]), ...single.map(item => item.transactionId), ...named.map(item => item.transactionId)]);
  const suggested = await proposeOwnNames(db, workspaceId, rows.filter(row => !handled.has(row.id)), [...rows, ...transfers], own);
  // Rows marked as cash a moment ago are transfers now; either way it is the bank's wording that counts.
  const cashCards = await proposeCashWithdrawals(db, workspaceId, [...rows.filter(row => !handled.has(row.id) || named.some(item => item.transactionId === row.id && item.account === "cash")), ...transfers]);
  return { linked, marked, skipped, suggested, cashCards };
}
