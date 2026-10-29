import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calendarDate } from "@/lib/finance/calendar";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import { wealthAmount } from "@/lib/finance/wealth";

type Context = { supabase: SupabaseClient; workspace: { id: string; timezone: string; locale: string }; chatRequestId?: string };
type Account = { id: string; name: string; type: string; currency_code: string };

/** The model's view of money the user spent or received: a decimal amount; the application turns it into exact minor units. */
export const transactionInputSchema = z.object({
  direction: z.enum(["spent", "received"]),
  amount: z.string().trim().regex(/^\d{1,15}(\.\d{1,4})?$/).describe("Positive decimal amount, e.g. 10 or 12.50"),
  currency: z.string().regex(/^[A-Z]{3}$/),
  description: z.string().trim().min(1).max(200).describe("What it was for, e.g. 'Lunch at Vapiano' or 'Rewe groceries'"),
  date: z.iso.date().optional().describe("When it happened; defaults to today"),
  account: z.string().trim().min(1).max(120).optional().describe("Only when the user named an account or how they paid, e.g. 'card', 'N26', 'cash'"),
  category: z.string().trim().min(1).max(100).optional().describe("An existing category name that fits, if any"),
}).strict();

export const transactionCreateSchema = z.object({
  direction: z.enum(["spent", "received"]), amountMinor: z.string().regex(/^[1-9]\d{0,17}$/), currencyCode: z.string().regex(/^[A-Z]{3}$/),
  date: z.iso.date(), description: z.string().trim().min(1).max(200), accountId: z.uuid().nullable(), categoryId: z.uuid().nullable(),
}).strict();

export async function liveAccounts(supabase: SupabaseClient, workspaceId: string, currency: string) {
  const { data, error } = await supabase.from("accounts").select("id, name, type, currency_code").eq("workspace_id", workspaceId)
    .eq("currency_code", currency).is("archived_at", null).order("created_at").limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as Account[];
}

/** The account a named payment method points to, else the first cash account; null means a Cash account is created on accept. */
export function chooseAccount(accounts: Account[], named?: string) {
  const word = named?.toLocaleLowerCase("en");
  const matches = word ? accounts.filter(account => account.name.toLocaleLowerCase("en").includes(word) || account.type === word
    || (word.includes("card") && ["checking", "credit"].includes(account.type))) : [];
  return (matches.length === 1 ? matches[0] : accounts.find(account => account.type === "cash"))?.id ?? null;
}

/** Stores a pending "add this transaction" proposal. Nothing reaches the ledger until the owner accepts. */
export async function proposeTransaction({ supabase, workspace, chatRequestId }: Context, input: z.infer<typeof transactionInputSchema>) {
  minorDigits(input.currency);
  const today = calendarDate(new Date(), workspace.timezone);
  const date = input.date ?? today;
  if (date > today) throw new Error("The date cannot be in the future");
  const [accounts, categories] = await Promise.all([liveAccounts(supabase, workspace.id, input.currency),
    input.category ? supabase.from("categories").select("id, name").eq("workspace_id", workspace.id).ilike("name", input.category).limit(1) : null]);
  if (categories?.error) throw new Error(categories.error.message);
  const category = categories?.data?.[0] as { id: string; name: string } | undefined;
  const payload = transactionCreateSchema.parse({ direction: input.direction, amountMinor: wealthAmount(input.amount, input.currency).toString(), currencyCode: input.currency,
    date, description: input.description, accountId: chooseAccount(accounts, input.account), categoryId: category?.id ?? null });
  const amount = formatMoney(payload.amountMinor, payload.currencyCode, workspace.locale);
  const title = `${payload.direction === "spent" ? "Spent" : "Received"} ${amount} · ${payload.description}`.slice(0, 200);
  const { data, error } = await supabase.from("agent_proposals").insert({ workspace_id: workspace.id, agent: "chat", kind: "transaction_create", ...(chatRequestId ? { chat_request_id: chatRequestId } : {}), 
    conflict_key: `transaction_create:${crypto.randomUUID()}`, title, detail: [date === today ? "Today" : date, category?.name].filter(Boolean).join(" · "), payload, confidence: 100 }).select("id").single();
  if (error) throw new Error(error.message);
  return { proposalId: data.id as string, title };
}

/** What the card offers: accounts in the proposal's currency, with the proposed one selected. */
export async function transactionAccountOptions(supabase: SupabaseClient, workspaceId: string, payload: unknown) {
  const parsed = transactionCreateSchema.parse(payload);
  const accounts = await liveAccounts(supabase, workspaceId, parsed.currencyCode);
  return { accounts: accounts.map(({ id, name }) => ({ id, name })), selected: parsed.accountId, needsCash: !accounts.some(account => account.type === "cash") };
}

/** Records the accepted proposal as an audited manual transaction; the proposal id is the request id, so accepting twice cannot duplicate it. */
export async function applyTransactionProposal({ supabase, workspace }: Context, proposalId: string, payload: unknown, accountOverride?: string) {
  const parsed = transactionCreateSchema.parse(payload);
  let accountId = accountOverride ?? parsed.accountId, createdAccount = false;
  if (!accountId) {
    const cash = (await liveAccounts(supabase, workspace.id, parsed.currencyCode)).find(account => account.type === "cash");
    if (cash) accountId = cash.id;
    else {
      const created = await supabase.from("accounts").insert({ workspace_id: workspace.id, name: "Cash", type: "cash", currency_code: parsed.currencyCode }).select("id").single();
      if (created.error) throw new Error(created.error.message);
      accountId = created.data.id as string; createdAccount = true;
    }
  }
  const account = await supabase.from("accounts").select("currency_code").eq("workspace_id", workspace.id).eq("id", accountId).is("archived_at", null).maybeSingle();
  if (account.error || !account.data) throw new Error("Account not found");
  if (account.data.currency_code !== parsed.currencyCode) throw new Error(`Choose an account in ${parsed.currencyCode}`);
  const { data, error } = await supabase.rpc("create_manual_transaction", { p_account_id: accountId, p_posted_on: parsed.date, p_description: parsed.description,
    p_amount_minor: parsed.direction === "spent" ? `-${parsed.amountMinor}` : parsed.amountMinor, p_status: "posted", p_category_id: parsed.categoryId,
    p_note: "Added from chat", p_request_id: proposalId });
  if (error) throw new Error(error.message);
  return { href: `/money/transactions?transaction=${data.id}`, undo: "Undo from the transaction", accountId, createdAccount };
}
