import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/database";
import { z } from "zod";
import { calendarDate } from "@/lib/finance/calendar";
import { formatMoney } from "@/lib/finance/format";
import { loadRawContext, type RawContext } from "@/lib/bank/raw-context";
import { normalizeIban } from "@/lib/iban";
import { wealthAmount } from "./wealth";
import { closingMovedTo } from "./account-closing";
import type { BankLeg } from "./transit";

export const MATCH_DAYS = 3;
const CLOSING_MATCH_DAYS = 30;

export type TransferContext = { locale: string; timezone: string; now: Date };

export function sourceIbans(row: unknown) {
  if (!row || typeof row !== "object") return [];
  return Object.values(row).flatMap(value => typeof value === "string" ? [normalizeIban(value)].filter((iban): iban is string => Boolean(iban)) : []);
}

export type TransferCandidate = {
  id: string; version: number; accountId: string; postedOn: string; amountMinor: bigint; currencyCode: string;
  reviewReasons: string[]; ibans: string[]; text?: string; counterparty?: string; transferId?: string | null;
  closingTo?: string;
  raw?: RawContext;
  identityId?: string | null;
};

const CASH = /\b(bargeldauszahlung|bargeldeinzahlung|geldautomat|cash withdrawal|atm withdrawal|cash deposit)\b/i;
const SCALABLE = /\bscalable capital\b/i, SCALABLE_LABEL = /\bscalable\b/i;
const REVOLUT_POCKET = /^(?:To|From) ([A-Z]{3})(?: MB:\S+)?$/, REVOLUT_EXCHANGE = /^Exchanged (?:to|from) ([A-Z]{3})$/;
const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
const revolutWording = (pattern: RegExp, text?: string) => { const code = pattern.exec(text?.trim() ?? "")?.[1]; return !!code && CURRENCIES.has(code); };
export type NamedAccount = "cash" | "scalable" | "pocket";
export const NAMED_LABELS: Record<NamedAccount, string> = { cash: "Cash", scalable: "Scalable Capital", pocket: "Revolut pocket" };
export type OwnAccounts = { tracked: Map<string, string>; untracked: Map<string, string>;
  names?: Map<string, string>; ids?: Map<string, string> };

const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

export type Leg = Pick<TransferCandidate, "id" | "accountId" | "postedOn" | "amountMinor" | "currencyCode">;

function namedIdentifier(row: TransferCandidate, own: OwnAccounts) {
  const key = row.counterparty ? nameKey(row.counterparty) : "";
  return key && !row.ibans.some(iban => own.tracked.get(iban) !== row.accountId) && nameKey(row.text ?? "").includes(key) ? own.names?.get(key) : undefined;
}

export function findOwnTransfers(rows: TransferCandidate[], own: OwnAccounts, legs: Leg[] = rows, options: { scalable?: boolean } = {}) {
  const counterparts = (row: TransferCandidate) => row.ibans.filter(iban => own.tracked.get(iban) !== row.accountId);
  const points = (row: TransferCandidate, accountId: string) => row.closingTo === accountId || counterparts(row).some(iban => own.tracked.get(iban) === accountId)
    || !!row.raw?.counterparty_ids.some(id => own.ids?.get(id.identification) === accountId);
  const matches = (out: TransferCandidate, into: TransferCandidate) => out.amountMinor < 0n && into.amountMinor === -out.amountMinor
    && out.currencyCode === into.currencyCode && out.accountId !== into.accountId && days(out.postedOn, into.postedOn) <= (out.closingTo || into.closingTo ? CLOSING_MATCH_DAYS : MATCH_DAYS);
  const used = new Set<string>();
  const pairs: { outId: string; inId: string }[] = [];
  const outs = rows.filter(row => row.amountMinor < 0n), ins = rows.filter(row => row.amountMinor > 0n);
  const take = (out: TransferCandidate, into: TransferCandidate) => { used.add(out.id); used.add(into.id); pairs.push({ outId: out.id, inId: into.id }); };

  for (const out of outs) {
    const proven = ins.filter(into => !used.has(into.id) && matches(out, into) && (points(out, into.accountId) || points(into, out.accountId)))
      .sort((a, b) => days(out.postedOn, a.postedOn) - days(out.postedOn, b.postedOn) || a.id.localeCompare(b.id));
    const tied = proven[1] && days(out.postedOn, proven[1].postedOn) === days(out.postedOn, proven[0].postedOn);
    if (!used.has(out.id) && proven[0] && !tied) take(out, proven[0]);
  }
  const unpaired = (row: TransferCandidate, accountId: string) => !legs.some(other => other.id !== row.id && other.accountId === accountId
    && other.currencyCode === row.currencyCode && other.amountMinor === -row.amountMinor && days(row.postedOn, other.postedOn) <= MATCH_DAYS);
  const single = rows.flatMap((row): { transactionId: string; identifierId?: string; iban?: string }[] => {
    if (used.has(row.id)) return [];
    const identifierId = counterparts(row).map(iban => own.untracked.get(iban)).find(Boolean) ?? namedIdentifier(row, own);
    if (identifierId) return [{ transactionId: row.id, identifierId }];
    const iban = counterparts(row).find(item => own.tracked.has(item));
    const accountId = iban ? own.tracked.get(iban) : undefined;
    return iban && accountId && unpaired(row, accountId) ? [{ transactionId: row.id, iban }] : [];
  });
  const marked = new Set(single.map(item => item.transactionId));
  const named = rows.flatMap((row): { transactionId: string; account: NamedAccount }[] => {
    if (used.has(row.id) || marked.has(row.id) || counterparts(row).some(iban => own.tracked.has(iban) || own.untracked.has(iban))) return [];
    if (CASH.test(row.text ?? "")) return [{ transactionId: row.id, account: "cash" }];
    if (revolutWording(REVOLUT_POCKET, row.text) && withoutOutsideParty(row)) return [{ transactionId: row.id, account: "pocket" }];
    if (options.scalable && SCALABLE.test(`${row.counterparty ?? ""} ${row.text ?? ""}`)) return [{ transactionId: row.id, account: "scalable" }];
    return [];
  });
  return { pairs, single, named };
}

const OUTSIDE = new Set(["card", "direct_debit", "cash", "fee_interest"]);
const EXCHANGE_DAYS = 1;
const noOutsideParty = (row: TransferCandidate) => !!row.raw && !OUTSIDE.has(row.raw.payment_type) && !row.raw.counterparty_name && (!row.raw.counterparty_iban || row.raw.own_account);
const withoutOutsideParty = (row: TransferCandidate) => !row.counterparty && (row.raw ? noOutsideParty(row) : row.ibans.length === 0);

export function exchangeEvidence(row: TransferCandidate) {
  const raw = row.raw;
  if (revolutWording(REVOLUT_EXCHANGE, row.text) && withoutOutsideParty(row)) return true;
  if (!raw || OUTSIDE.has(raw.payment_type)) return false;
  return raw.payment_type === "exchange" || ((!!raw.exchange_rate || (!!raw.instructed_currency && raw.instructed_currency !== row.currencyCode)) && noOutsideParty(row));
}

const instructedMinor = (row: TransferCandidate) => {
  try { return row.raw?.instructed_amount && row.raw.instructed_currency ? wealthAmount(row.raw.instructed_amount.replace(/^-/, ""), row.raw.instructed_currency) : null; } catch { return null; }
};
const magnitude = (amount: bigint) => amount < 0n ? -amount : amount;

export function findExchanges(rows: TransferCandidate[]) {
  const stated = (a: TransferCandidate, b: TransferCandidate) => a.raw?.instructed_currency !== b.currencyCode || instructedMinor(a) === null || instructedMinor(a) === magnitude(b.amountMinor);
  const fits = (leg: TransferCandidate, other: TransferCandidate) => other.id !== leg.id && other.accountId !== leg.accountId && other.currencyCode !== leg.currencyCode
    && other.amountMinor !== 0n && (other.amountMinor < 0n) !== (leg.amountMinor < 0n) && days(leg.postedOn, other.postedOn) <= EXCHANGE_DAYS
    && (exchangeEvidence(other) || noOutsideParty(other)) && stated(leg, other) && stated(other, leg);
  const used = new Set<string>();
  const pairs: { outId: string; inId: string }[] = [], single: string[] = [];
  for (const leg of rows.filter(exchangeEvidence).sort((a, b) => a.id.localeCompare(b.id))) {
    if (used.has(leg.id)) continue;
    const others = rows.filter(other => !used.has(other.id) && fits(leg, other));
    const back = others.length === 1 ? rows.filter(item => !used.has(item.id) && fits(others[0], item)) : [];
    used.add(leg.id);
    if (back.length === 1) {
      used.add(others[0].id);
      pairs.push(leg.amountMinor < 0n ? { outId: leg.id, inId: others[0].id } : { outId: others[0].id, inId: leg.id });
    } else single.push(leg.id);
  }
  return { pairs, single };
}

export function uncertainPairs(rows: TransferCandidate[]) {
  const outsider = (row: TransferCandidate) => !!row.raw && (OUTSIDE.has(row.raw.payment_type) || row.raw.payment_type === "exchange" || !!row.raw.counterparty_iban || !!row.raw.creditor_id);
  const open = rows.filter(row => !outsider(row));
  const matches = (out: TransferCandidate, into: TransferCandidate) => out.amountMinor < 0n && into.amountMinor === -out.amountMinor && out.currencyCode === into.currencyCode
    && out.accountId !== into.accountId && days(out.postedOn, into.postedOn) <= MATCH_DAYS;
  return open.flatMap(out => {
    const ins = open.filter(into => matches(out, into));
    return ins.length === 1 && open.filter(other => matches(other, ins[0])).length === 1 ? [{ outId: out.id, inId: ins[0].id }] : [];
  });
}

export const CASH_CARD_DAYS = 30;
export function cashWithdrawals<T extends Pick<TransferCandidate, "id" | "postedOn" | "amountMinor" | "text" | "transferId">>(rows: T[], today: string, answered = new Set<string>()) {
  return rows.filter(row => row.amountMinor < 0n && !row.transferId && CASH.test(row.text ?? "") && !answered.has(row.id) && days(row.postedOn, today) <= CASH_CARD_DAYS);
}

export const nameKey = (name: string) => name.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

export function ownNameSuggestions(rows: TransferCandidate[], seen: TransferCandidate[], own: OwnAccounts, answered = new Set<string>()) {
  const names = new Map<string, string>();
  for (const row of seen) {
    const other = row.ibans.filter(iban => own.tracked.get(iban) !== row.accountId);
    if (row.counterparty?.trim() && other.some(iban => own.tracked.has(iban) || own.untracked.has(iban))) names.set(nameKey(row.counterparty), row.counterparty.trim());
  }
  return rows.flatMap(row => {
    const name = row.counterparty ? names.get(nameKey(row.counterparty)) : undefined;
    return name && !answered.has(row.id) && nameKey(row.text ?? "").includes(nameKey(name)) ? [{ transactionId: row.id, name }] : [];
  });
}

const PAGE = 1000, MAX_ROWS = 5000;

export async function loadOwnAccounts(db: Db, workspaceId: string): Promise<OwnAccounts> {
  const [identifiers, bank, accounts] = await Promise.all([
    db.from("own_account_identifiers").select("id, account_id, iban, name_key").eq("workspace_id", workspaceId),
    db.from("bank_connection_accounts").select("iban, account_name, currency_code").eq("workspace_id", workspaceId).not("iban", "is", null),
    db.from("accounts").select("id, name, currency_code").eq("workspace_id", workspaceId),
  ]);
  for (const result of [identifiers, bank, accounts]) if (result.error) throw new Error(result.error.message);
  const tracked = new Map<string, string>(), untracked = new Map<string, string>(), names = new Map<string, string>();
  for (const row of bank.data ?? []) {
    const account = accounts.data?.find(item => item.name === row.account_name && item.currency_code === row.currency_code);
    const iban = normalizeIban(row.iban ?? "");
    if (account && iban) tracked.set(iban, account.id);
  }
  for (const row of identifiers.data ?? []) {
    if (row.name_key) names.set(row.name_key, row.id);
    else if (row.iban && row.account_id) tracked.set(row.iban, row.account_id);
    else if (row.iban) untracked.set(row.iban, row.id);
  }
  return { tracked, untracked, names };
}

const counterpartyOf = (row: unknown) => {
  const value = row && typeof row === "object" ? (row as { counterparty?: unknown }).counterparty : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

async function loadRows(db: Db, workspaceId: string, kind: "ordinary" | "transfer") {
  const rows: TransferCandidate[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    let query = db.from("transactions")
      .select("id, version, account_id, posted_on, amount_minor::text, currency_code, review_reasons, description, transfer_id, identity_id, transaction_sources(source_transactions(original_row))")
      .eq("workspace_id", workspaceId).eq("status", "posted").eq("kind", kind);
    if (kind === "ordinary") query = query.is("transfer_id", null).is("refund_of_id", null);
    const { data, error } = await query.order("posted_on", { ascending: false }).order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const reviewReasons = row.review_reasons ?? [];
      if (kind === "ordinary" && reviewReasons.some(reason => reason !== "source_transfer")) continue;
      const originals = (row.transaction_sources ?? []).map(source => source.source_transactions?.original_row);
      rows.push({ id: row.id, version: row.version, accountId: row.account_id, postedOn: row.posted_on, amountMinor: BigInt(row.amount_minor),
        currencyCode: row.currency_code, reviewReasons, ibans: [...new Set(originals.flatMap(sourceIbans))], text: row.description, counterparty: originals.map(counterpartyOf).find(Boolean), transferId: row.transfer_id, identityId: row.identity_id });
    }
    if ((data ?? []).length < PAGE) break;
  }
  return rows;
}

export const loadTransferCandidates = (db: Db, workspaceId: string) => loadRows(db, workspaceId, "ordinary");

export async function loadTransferLegs(db: Db, workspaceId: string): Promise<BankLeg[]> {
  const [rows, own, identifiers] = await Promise.all([loadRows(db, workspaceId, "transfer"), loadOwnAccounts(db, workspaceId),
    db.from("own_account_identifiers").select("iban, label").eq("workspace_id", workspaceId)]);
  if (identifiers.error) throw new Error(identifiers.error.message);
  const brokerIbans = new Set((identifiers.data ?? []).filter(row => row.iban && SCALABLE_LABEL.test(row.label)).map(row => row.iban as string));
  return rows.map(row => ({ id: row.id, accountId: row.accountId, amountMinor: row.amountMinor, currencyCode: row.currencyCode, postedOn: row.postedOn, transferId: row.transferId ?? null, text: row.text,
    provesBroker: row.ibans.some(iban => brokerIbans.has(iban)) || SCALABLE.test(`${row.counterparty ?? ""} ${row.text ?? ""}`),
    ownAccount: row.ibans.some(iban => own.tracked.has(iban) && own.tracked.get(iban) !== row.accountId) }));
}

async function loadLegs(db: Db, workspaceId: string): Promise<Leg[]> {
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

export const ownTransferPayloadSchema = z.union([z.object({ transactionId: z.uuid(), name: z.string().trim().min(1).max(120) }).strict(),
  z.object({ transactionId: z.uuid(), pairWith: z.uuid() }).strict()]);

async function proposeOwnNames(db: Db, workspaceId: string, rows: TransferCandidate[], seen: TransferCandidate[], own: OwnAccounts, locale: string) {
  const known = await db.from("agent_proposals").select("conflict_key").eq("workspace_id", workspaceId).is("run_id", null).eq("kind", "own_transfer").limit(5000);
  if (known.error) throw new Error(known.error.message);
  const answered = new Set((known.data ?? []).map(row => String(row.conflict_key).replace(/^own_transfer:/, "")));
  const found = ownNameSuggestions(rows, seen, own, answered);
  if (!found.length) return 0;
  const byId = new Map(rows.map(row => [row.id, row]));
  const cards = found.map(({ transactionId, name }) => {
    const row = byId.get(transactionId)!, money = formatMoney(row.amountMinor < 0n ? -row.amountMinor : row.amountMinor, row.currencyCode, locale);
    return { workspace_id: workspaceId, agent: "chat", kind: "own_transfer", conflict_key: `own_transfer:${transactionId}`, confidence: 70,
      title: (row.amountMinor < 0n ? `${money} to ${name}: your own account?` : `${money} from ${name}: your own account?`).slice(0, 200),
      detail: `You sent money under the name ${name} to one of your own accounts before. If this is yours too, Moneo remembers it as an account it doesn't track, moves every payment with it to transfers so none counts as spending or income, and doesn't ask again. Undoing any of them undoes them all.`,
      evidence: { facts: [], transactions: [{ id: row.id, date: row.postedOn, description: row.text ?? "", amountMinor: row.amountMinor.toString(), currency: row.currencyCode }], links: [] },
      payload: ownTransferPayloadSchema.parse({ transactionId, name }) };
  });
  const { data, error } = await db.from("agent_proposals").insert(cards).select("id");
  if (error && error.code !== "23505") throw new Error(error.message);
  return data?.length ?? 0;
}

async function proposeCashWithdrawals(db: Db, workspaceId: string, rows: TransferCandidate[], { locale, timezone, now }: TransferContext) {
  const known = await db.from("agent_proposals").select("conflict_key").eq("workspace_id", workspaceId).is("run_id", null).eq("kind", "cash_withdrawal").limit(5000);
  if (known.error) throw new Error(known.error.message);
  const answered = new Set((known.data ?? []).map(row => String(row.conflict_key).replace(/^cash_withdrawal:/, "")));
  const found = cashWithdrawals(rows, calendarDate(now, timezone), answered);
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

async function proposePairs(db: Db, workspaceId: string, pairs: { outId: string; inId: string }[], byId: Map<string, TransferCandidate>, accounts: { id: string; name: string }[], locale: string) {
  if (!pairs.length) return 0;
  const known = await db.from("agent_proposals").select("conflict_key").eq("workspace_id", workspaceId).is("run_id", null).eq("kind", "own_transfer").limit(5000);
  if (known.error) throw new Error(known.error.message);
  const answered = new Set((known.data ?? []).map(row => String(row.conflict_key)));
  const fresh = pairs.filter(pair => !answered.has(`own_transfer:${pair.outId}:${pair.inId}`));
  if (!fresh.length) return 0;
  const name = (id: string) => accounts.find(account => account.id === id)?.name ?? "another account";
  const cards = fresh.map(({ outId, inId }) => {
    const out = byId.get(outId)!, into = byId.get(inId)!, money = formatMoney(-out.amountMinor, out.currencyCode, locale);
    return { workspace_id: workspaceId, agent: "chat", kind: "own_transfer", conflict_key: `own_transfer:${outId}:${inId}`, confidence: 60,
      title: `${money} from ${name(out.accountId)} to ${name(into.accountId)}: moved between your accounts?`.slice(0, 200),
      detail: "The same amount left one of your accounts and arrived in another within a few days, but nothing from the bank proves both sides are yours. If they are, they become one transfer and stop counting as spending and income.",
      evidence: { facts: [], transactions: [out, into].map(row => ({ id: row.id, date: row.postedOn, description: row.text ?? "", amountMinor: row.amountMinor.toString(), currency: row.currencyCode })), links: [] },
      payload: ownTransferPayloadSchema.parse({ transactionId: outId, pairWith: inId }) };
  });
  const { data, error } = await db.from("agent_proposals").insert(cards).select("id");
  if (error && error.code !== "23505") throw new Error(error.message);
  return data?.length ?? 0;
}

export function withBankContext(rows: TransferCandidate[], raw: Map<string, RawContext>) {
  for (const row of rows) {
    row.raw = raw.get(row.id);
    const iban = normalizeIban(row.raw?.counterparty_iban ?? "");
    if (iban && !row.ibans.includes(iban)) row.ibans.push(iban);
  }
  return rows;
}

function ownAccountIds(rows: TransferCandidate[]) {
  const ids = new Map<string, string | null>();
  for (const row of rows) for (const { identification } of row.raw?.own_side_ids ?? []) {
    const seen = ids.get(identification);
    ids.set(identification, seen === undefined || seen === row.accountId ? row.accountId : null);
  }
  return new Map([...ids].filter((entry): entry is [string, string] => entry[1] !== null));
}

export async function linkOwnTransfers(db: Db, workspaceId: string, context: TransferContext) {
  const [own, rows, legs, transfers, scalable] = await Promise.all([loadOwnAccounts(db, workspaceId), loadTransferCandidates(db, workspaceId), loadLegs(db, workspaceId),
    loadRows(db, workspaceId, "transfer"), db.from("scalable_connections").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "active")]);
  if (scalable.error) throw new Error(scalable.error.message);
  const { data: accounts, error: accountsError } = await db.from("accounts").select("id, name, currency_code").eq("workspace_id", workspaceId);
  if (accountsError) throw new Error(accountsError.message);
  for (const row of rows) { const name = closingMovedTo(row.text); if (name) row.closingTo = accounts?.find(account => account.name === name && account.currency_code === row.currencyCode)?.id; }
  withBankContext(rows, await loadRawContext(db, workspaceId, rows.map(row => row.id)));
  own.ids = ownAccountIds(rows);
  const { pairs, single, named } = findOwnTransfers(rows, own, legs, { scalable: (scalable.count ?? 0) > 0 });
  const byId = new Map(rows.map(row => [row.id, row]));
  let linked = 0, marked = 0, skipped = 0;
  for (const pair of pairs) {
    const out = byId.get(pair.outId)!, into = byId.get(pair.inId)!;
    const { error } = await db.rpc("link_transactions", { p_operation: "transfer", p_primary_id: out.id, p_expected_version: out.version,
      p_other_id: into.id, p_other_version: into.version, p_fx_rate_id: null, p_fees: [], p_request_id: randomUUID() });
    if (error) skipped++; else linked++;
  }
  for (const item of single) {
    const expectedVersion = byId.get(item.transactionId)!.version;
    const { error } = item.identifierId
      ? await db.rpc("mark_own_account_transfer", { p_transaction_id: item.transactionId, p_expected_version: expectedVersion, p_identifier_id: item.identifierId })
      : await db.rpc("mark_own_iban_transfer", { p_transaction_id: item.transactionId, p_expected_version: expectedVersion, p_iban: item.iban ?? null });
    if (error) skipped++; else marked++;
  }
  for (const item of named) {
    const { error } = await db.rpc("mark_own_named_transfer", { p_transaction_id: item.transactionId, p_expected_version: byId.get(item.transactionId)!.version, p_kind: item.account });
    if (error) skipped++; else marked++;
  }
  const handled = new Set([...pairs.flatMap(pair => [pair.outId, pair.inId]), ...single.map(item => item.transactionId), ...named.map(item => item.transactionId)]);
  const exchanges = findExchanges(rows.filter(row => !handled.has(row.id)));
  const exchangeLegs: [string, string | null][] = [...exchanges.pairs.flatMap((pair): [string, string][] => [[pair.outId, pair.inId], [pair.inId, pair.outId]]),
    ...exchanges.single.map((id): [string, null] => [id, null])];
  for (const [id, other] of exchangeLegs) {
    const { error } = await db.rpc("mark_own_exchange", { p_transaction_id: id, p_expected_version: byId.get(id)!.version, p_counterpart_id: other });
    if (error) skipped++; else marked++;
    handled.add(id);
  }
  const unproven = uncertainPairs(rows.filter(row => !handled.has(row.id)));
  const pairCards = await proposePairs(db, workspaceId, unproven, byId, accounts ?? [], context.locale);
  for (const pair of unproven) { handled.add(pair.outId); handled.add(pair.inId); }
  const suggested = await proposeOwnNames(db, workspaceId, rows.filter(row => !handled.has(row.id)), [...rows, ...transfers], own, context.locale);
  const cashCards = await proposeCashWithdrawals(db, workspaceId, [...rows.filter(row => !handled.has(row.id) || named.some(item => item.transactionId === row.id && item.account === "cash")), ...transfers], context);
  return { linked, marked, skipped, suggested: suggested + pairCards, cashCards };
}

export async function confirmOwnAccount(db: Db, workspaceId: string, transactionId: string, name: string, context: TransferContext) {
  const [own, rows] = await Promise.all([loadOwnAccounts(db, workspaceId), loadTransferCandidates(db, workspaceId)]);
  const target = rows.find(row => row.id === transactionId);
  if (!target) throw new Error("This transaction was removed");
  const strangers = target.ibans.filter(iban => own.tracked.get(iban) !== target.accountId && !own.tracked.has(iban) && !own.untracked.has(iban));
  const identity = strangers.length === 1 ? { iban: strangers[0] } : { name_key: nameKey(name) };
  const saved = await db.from("own_account_identifiers").insert({ workspace_id: workspaceId, account_id: null, label: name, confirmed: true, ...identity }).select("id").single();
  let identifierId = saved.data?.id as string | undefined;
  if (saved.error?.code === "23505") {
    const existing = await db.from("own_account_identifiers").select("id").eq("workspace_id", workspaceId).match(identity).single();
    if (existing.error) throw new Error(existing.error.message);
    identifierId = existing.data.id;
  } else if (saved.error) throw new Error(saved.error.message);
  const marked = await db.rpc("mark_own_account_transfer", { p_transaction_id: transactionId, p_expected_version: target.version, p_identifier_id: identifierId ?? null });
  if (marked.error) throw new Error(marked.error.message);
  const linked = await linkOwnTransfers(db, workspaceId, context);
  const open = await db.from("agent_proposals").select("id, payload").eq("workspace_id", workspaceId).is("run_id", null).eq("kind", "own_transfer").in("status", ["proposed", "failed"]).limit(5000);
  if (open.error) throw new Error(open.error.message);
  const asked = new Map((open.data ?? []).flatMap(row => {
    const payload = ownTransferPayloadSchema.safeParse(row.payload);
    return payload.success && "name" in payload.data ? [[payload.data.transactionId, row.id as string] as const] : [];
  }));
  if (asked.size) {
    const answered = await db.from("transactions").select("id").eq("workspace_id", workspaceId).eq("kind", "transfer").in("id", [...asked.keys()]);
    if (answered.error) throw new Error(answered.error.message);
    const closed = (answered.data ?? []).map(row => asked.get(row.id as string)!);
    if (closed.length) {
      const result = await db.from("agent_proposals").update({ status: "accepted", decided_at: new Date().toISOString(), result: { href: "/money/transactions?kind=transfer", undo: "Undo from the transaction" } }).in("id", closed);
      if (result.error) throw new Error(result.error.message);
    }
  }
  return { ...linked, identifierId: identifierId! };
}
