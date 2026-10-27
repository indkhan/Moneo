import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { liveAccounts } from "@/lib/ai/transaction-proposals";
import { calendarDate } from "@/lib/finance/calendar";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import { wealthAmount } from "@/lib/finance/wealth";

type Context = { supabase: SupabaseClient; workspace: { id: string; timezone: string; locale: string } };

/** The model's view of a balance the user states: a decimal amount; the application turns it into exact minor units. */
export const balanceInputSchema = z.object({
  account: z.string().trim().min(1).max(120).optional().describe("The account's name, e.g. 'Wallet EUR'. Omit for cash: the currency's single cash account, or a new Cash account when there is none"),
  amount: z.string().trim().regex(/^-?\d{1,15}(\.\d{1,4})?$/).describe("The balance as a decimal, e.g. 115 or 1250.40"),
  currency: z.string().regex(/^[A-Z]{3}$/),
  asOf: z.iso.date().optional().describe("The date the balance was true; defaults to today"),
}).strict();

/** A null accountId means the accepted proposal creates the currency's Cash account first. */
export const balanceSetSchema = z.object({
  accountId: z.uuid().nullable(), amountMinor: z.string().regex(/^-?\d{1,18}$/), currencyCode: z.string().regex(/^[A-Z]{3}$/), asOf: z.iso.date(),
}).strict();

/** Stores a pending "set this account's balance" proposal. Nothing changes until the owner accepts. */
export async function proposeBalance({ supabase, workspace }: Context, input: z.infer<typeof balanceInputSchema>) {
  minorDigits(input.currency);
  const today = calendarDate(new Date(), workspace.timezone);
  const asOf = input.asOf ?? today;
  if (asOf > today) throw new Error("The date cannot be in the future");
  const accounts = await liveAccounts(supabase, workspace.id, input.currency);
  const word = input.account?.toLocaleLowerCase("en");
  const cash = accounts.filter(account => account.type === "cash");
  const pool = word ? accounts.filter(account => account.name.toLocaleLowerCase("en").includes(word)) : cash;
  const createCash = !word && cash.length === 0;
  if (!createCash && pool.length !== 1) throw new Error(word ? `No single ${input.currency} account matches "${input.account}"` : `Name the ${input.currency} account whose balance this is`);
  const account = pool[0];
  const payload = balanceSetSchema.parse({ accountId: account?.id ?? null, amountMinor: wealthAmount(input.amount, input.currency).toString(), currencyCode: input.currency, asOf });
  const amount = formatMoney(payload.amountMinor, payload.currencyCode, workspace.locale);
  const title = (account ? `Set ${account.name} balance to ${amount}` : `Create a Cash ${input.currency} account and set its balance to ${amount}`).slice(0, 200);
  const { data, error } = await supabase.from("agent_proposals").insert({ workspace_id: workspace.id, agent: "chat", kind: "balance_set",
    conflict_key: `balance_set:${crypto.randomUUID()}`, title, detail: asOf === today ? "Today" : asOf, payload, confidence: 100 }).select("id").single();
  if (error) throw new Error(error.message);
  return { proposalId: data.id as string, title };
}

/** Records the accepted balance through the same audited RPC as Accounts; the proposal id is the request id, so accepting twice cannot duplicate it. */
export async function applyBalanceProposal({ supabase, workspace }: Context, proposalId: string, payload: unknown) {
  const parsed = balanceSetSchema.parse(payload);
  let accountId = parsed.accountId, createdAccount = false;
  if (accountId) {
    const account = await supabase.from("accounts").select("currency_code").eq("workspace_id", workspace.id).eq("id", accountId).is("archived_at", null).maybeSingle();
    if (account.error || !account.data) throw new Error("Account not found");
    if (account.data.currency_code !== parsed.currencyCode) throw new Error(`Choose an account in ${parsed.currencyCode}`);
  } else {
    const created = await supabase.from("accounts").insert({ workspace_id: workspace.id, name: "Cash", type: "cash", currency_code: parsed.currencyCode }).select("id").single();
    if (created.error) throw new Error(created.error.message);
    accountId = created.data.id as string; createdAccount = true;
  }
  // The RPC refuses the write if the history changed since this read, so the owner is never overwriting an unseen balance.
  const latest = await supabase.from("balance_snapshots").select("id, version").eq("workspace_id", workspace.id).eq("account_id", accountId)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
  if (latest.error) throw new Error(latest.error.message);
  const { error } = await supabase.rpc("record_manual_balance", { p_account_id: accountId, p_amount_minor: parsed.amountMinor, p_date: parsed.asOf,
    p_reviewed: false, p_covered_transactions: null, p_expected_snapshot_id: latest.data?.id ?? null, p_expected_version: latest.data?.version ?? 0, p_request_id: proposalId });
  if (error) throw new Error(error.message);
  return { href: "/money/accounts", undo: "Undo the balance on Accounts", accountId, createdAccount };
}
