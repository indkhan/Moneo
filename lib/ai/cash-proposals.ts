import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { liveAccounts } from "@/lib/ai/transaction-proposals";
import { loadBalanceEvidence, resolveBalances } from "@/lib/finance/balances";
import { calendarDate } from "@/lib/finance/calendar";

type Context = { supabase: SupabaseClient; workspace: { id: string; timezone: string; locale: string } };

export const cashWithdrawalSchema = z.object({ transactionId: z.uuid(), amountMinor: z.string().regex(/^[1-9]\d{0,17}$/), currencyCode: z.string().regex(/^[A-Z]{3}$/), date: z.iso.date() }).strict();

/** What the card offers: the cash accounts in that currency, the only one already chosen; with none, accepting creates one. */
export async function cashAccountOptions(supabase: SupabaseClient, workspaceId: string, payload: unknown) {
  const parsed = cashWithdrawalSchema.parse(payload);
  const cash = (await liveAccounts(supabase, workspaceId, parsed.currencyCode)).filter(account => account.type === "cash");
  return { accounts: cash.map(({ id, name }) => ({ id, name })), selected: cash.length === 1 ? cash[0].id : null, createsCash: cash.length === 0 };
}

const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

/**
 * Adds the withdrawn cash to a Cash account as an own transfer, so what left the bank counts as still yours. The proposal id
 * is the request id, so accepting twice can't add it twice. Spending it later is the owner's own balance update.
 */
export async function applyCashWithdrawal({ supabase, workspace }: Context, proposalId: string, payload: unknown, accountOverride?: string) {
  const parsed = cashWithdrawalSchema.parse(payload);
  const bank = await supabase.from("transactions").select("status, amount_minor::text, currency_code").eq("workspace_id", workspace.id).eq("id", parsed.transactionId).maybeSingle();
  if (bank.error || !bank.data || bank.data.status !== "posted" || bank.data.currency_code !== parsed.currencyCode || BigInt(bank.data.amount_minor) !== -BigInt(parsed.amountMinor))
    throw new Error("The withdrawal changed since this card was made");
  const options = await cashAccountOptions(supabase, workspace.id, parsed);
  let accountId = accountOverride ?? options.selected, createdAccount = false;
  if (accountId && !options.accounts.some(account => account.id === accountId)) throw new Error("Choose a Cash account");
  if (!accountId) {
    if (options.accounts.length) throw new Error("Choose a Cash account");
    const created = await supabase.from("accounts").insert({ workspace_id: workspace.id, name: "Cash", type: "cash", currency_code: parsed.currencyCode }).select("id").single();
    if (created.error) throw new Error(created.error.message);
    accountId = created.data.id as string; createdAccount = true;
  }
  const balance = async () => {
    const evidence = await loadBalanceEvidence(supabase, workspace.id);
    return resolveBalances(evidence.accounts.filter(account => account.id === accountId), evidence.snapshots, evidence.ledger, evidence.asOf, workspace.timezone)[0]?.balance ?? null;
  };
  const before = await balance();
  const entry = await supabase.rpc("create_manual_transaction", { p_account_id: accountId, p_posted_on: parsed.date, p_description: "Cash withdrawn from the bank", p_amount_minor: parsed.amountMinor,
    p_status: "posted", p_category_id: null, p_note: "Added from a cash withdrawal card", p_request_id: proposalId });
  if (entry.error) throw new Error(entry.error.message);
  const row = await supabase.from("transactions").select("id, kind, version").eq("id", entry.data.id).single();
  if (row.error) throw new Error(row.error.message);
  if (row.data.kind === "ordinary") {
    const marked = await supabase.rpc("mark_own_named_transfer", { p_transaction_id: row.data.id, p_expected_version: row.data.version, p_kind: "cash" });
    if (marked.error) throw new Error(marked.error.message);
  }
  const record = async (amount: string, date: string) => {
    const latest = await supabase.from("balance_snapshots").select("id, version").eq("workspace_id", workspace.id).eq("account_id", accountId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
    if (latest.error) throw new Error(latest.error.message);
    const saved = await supabase.rpc("record_manual_balance", { p_account_id: accountId, p_amount_minor: amount, p_date: date, p_reviewed: false, p_covered_transactions: null,
      p_expected_snapshot_id: latest.data?.id ?? null, p_expected_version: latest.data?.version ?? 0, p_request_id: crypto.randomUUID() });
    if (saved.error) throw new Error(saved.error.message);
  };
  // A Cash account with no balance yet starts from nothing the day before, so the withdrawal itself is the money in it.
  if (before?.amount_minor == null) await record("0", dayBefore(parsed.date));
  else {
    // A balance typed in after the withdrawal hides a row dated before it, so that balance moves instead.
    const after = await balance(), expected = BigInt(before.amount_minor) + BigInt(parsed.amountMinor);
    if (after?.amount_minor !== expected.toString()) await record(expected.toString(), calendarDate(new Date(), workspace.timezone));
  }
  return { href: "/money/accounts", undo: "Undo from the transaction", accountId, createdAccount };
}
