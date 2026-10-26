import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Money moved between the owner's own accounts is a transfer, never income or spending.
// Detection is deterministic: IBAN evidence from the source rows, or an exact opposite
// amount between two own accounts that the statement itself calls a transfer. Every
// decision goes through the audited link RPCs, so each one can be undone.

export const MATCH_DAYS = 3;
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
  reviewReasons: string[]; ibans: string[];
};
export type OwnAccounts = { tracked: Map<string, string>; untracked: Map<string, string> }; // IBAN → account id / identifier id

const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

export function findOwnTransfers(rows: TransferCandidate[], own: OwnAccounts) {
  // The posting account's own IBAN often appears in its row too; only the other side counts.
  const counterparts = (row: TransferCandidate) => row.ibans.filter(iban => own.tracked.get(iban) !== row.accountId);
  const points = (row: TransferCandidate, accountId: string) => counterparts(row).some(iban => own.tracked.get(iban) === accountId);
  const matches = (out: TransferCandidate, into: TransferCandidate) => out.amountMinor < 0n && into.amountMinor === -out.amountMinor
    && out.currencyCode === into.currencyCode && out.accountId !== into.accountId && days(out.postedOn, into.postedOn) <= MATCH_DAYS;
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
  // Without IBAN evidence: the statement says transfer and the match is unambiguous both ways.
  for (const out of outs) {
    if (used.has(out.id)) continue;
    const options = ins.filter(into => !used.has(into.id) && matches(out, into));
    if (options.length !== 1) continue;
    const into = options[0];
    if (outs.filter(other => !used.has(other.id) && matches(other, into)).length !== 1) continue;
    if (out.reviewReasons.includes("source_transfer") || into.reviewReasons.includes("source_transfer")) take(out, into);
  }
  // A leg that names an own account Moneo doesn't track.
  const single = rows.flatMap(row => {
    if (used.has(row.id)) return [];
    const identifierId = counterparts(row).map(iban => own.untracked.get(iban)).find(Boolean);
    return identifierId ? [{ transactionId: row.id, identifierId }] : [];
  });
  return { pairs, single };
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

type Row = { id: string; version: number; account_id: string; posted_on: string; amount_minor: string; currency_code: string; review_reasons: string[] | null;
  transaction_sources: { source_transactions: { original_row: unknown } | null }[] | null };

export async function loadTransferCandidates(db: SupabaseClient, workspaceId: string) {
  const rows: TransferCandidate[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await db.from("transactions")
      .select("id, version, account_id, posted_on, amount_minor::text, currency_code, review_reasons, transaction_sources(source_transactions(original_row))")
      .eq("workspace_id", workspaceId).eq("status", "posted").eq("kind", "ordinary").is("transfer_id", null).is("refund_of_id", null)
      .order("posted_on", { ascending: false }).order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as unknown as Row[]) {
      const reviewReasons = row.review_reasons ?? [];
      if (reviewReasons.some(reason => reason !== "source_transfer")) continue;
      rows.push({ id: row.id, version: row.version, accountId: row.account_id, postedOn: row.posted_on, amountMinor: BigInt(row.amount_minor),
        currencyCode: row.currency_code, reviewReasons, ibans: [...new Set((row.transaction_sources ?? []).flatMap(source => sourceIbans(source.source_transactions?.original_row)))] });
    }
    if ((data ?? []).length < PAGE) break;
  }
  return rows;
}

/** Find and link transfers between the owner's accounts, as the signed-in user. */
export async function linkOwnTransfers(db: SupabaseClient, workspaceId: string) {
  const [own, rows] = await Promise.all([loadOwnAccounts(db, workspaceId), loadTransferCandidates(db, workspaceId)]);
  const { pairs, single } = findOwnTransfers(rows, own);
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
    const { error } = await db.rpc("mark_own_account_transfer", { p_transaction_id: item.transactionId, p_expected_version: byId.get(item.transactionId)!.version, p_identifier_id: item.identifierId });
    if (error) skipped++; else marked++;
  }
  return { linked, marked, skipped };
}
