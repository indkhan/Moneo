import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calendarDate } from "@/lib/finance/calendar";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import { iouCreateSchema, loanPayouts, parseIouName, repaymentMatches, type IouItem, type LoanStart } from "@/lib/finance/iou";
import { wealthAmount } from "@/lib/finance/wealth";

type Context = { supabase: SupabaseClient; workspace: { id: string; timezone: string; locale: string }; chatRequestId?: string };

/** The model's view of a new IOU: a decimal amount; the application turns it into exact minor units. */
export const iouInputSchema = z.object({ direction: z.enum(["lent", "borrowed"]).describe("lent: the user gave money to the person; borrowed: the user received money from the person"),
  person: z.string().trim().min(1).max(100), amount: z.string().trim().regex(/^\d{1,15}(\.\d{1,4})?$/).describe("Positive decimal amount, e.g. 500 or 12.50"),
  currency: z.string().regex(/^[A-Z]{3}$/), date: z.iso.date().optional().describe("When the money changed hands; defaults to today") }).strict();

const sentence = (direction: "lent" | "borrowed", person: string, amount: string) => direction === "lent" ? `${person} owes you ${amount}` : `You owe ${person} ${amount}`;

const firstName = (person: string) => person.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase().split(/\s+/)[0];

/** Stores a pending "add this loan to Wealth" proposal. Nothing is written to Wealth until the owner accepts.
 * `earlier` are the cards this chat already showed: an open one for the same loan is dismissed, so a correction
 * ("his name is Bilal Amin, it was in September") cannot be added twice. */
export async function proposeIou({ supabase, workspace, chatRequestId }: Context, input: z.infer<typeof iouInputSchema>, earlier: string[] = []) {
  minorDigits(input.currency);
  const today = calendarDate(new Date(), workspace.timezone);
  const payload = iouCreateSchema.parse({ direction: input.direction, person: input.person, currencyCode: input.currency, date: input.date ?? today,
    amountMinor: wealthAmount(input.amount, input.currency).toString() });
  if (payload.date > today) throw new Error("The date cannot be in the future");
  const formatted = formatMoney(payload.amountMinor, payload.currencyCode, workspace.locale);
  const { data, error } = await supabase.from("agent_proposals").insert({ workspace_id: workspace.id, agent: "chat", kind: "iou_create", ...(chatRequestId ? { chat_request_id: chatRequestId } : {}),  conflict_key: `iou_create:${crypto.randomUUID()}`,
    title: sentence(payload.direction, payload.person, formatted), detail: `${payload.direction === "lent" ? "Lent" : "Borrowed"} on ${payload.date}. Added to Wealth and net worth once you accept.`,
    payload, confidence: 100 }).select("id").single();
  if (error) throw new Error(error.message);
  let replaced = 0;
  if (earlier.length) {
    const open = await supabase.from("agent_proposals").select("id, payload").eq("workspace_id", workspace.id).is("run_id", null).eq("kind", "iou_create")
      .in("status", ["proposed", "failed"]).in("id", earlier);
    if (open.error) throw new Error(open.error.message);
    const same = (open.data ?? []).filter(row => row.payload?.direction === payload.direction && firstName(String(row.payload?.person ?? "")) === firstName(payload.person)).map(row => row.id as string);
    if (same.length) {
      const dismissed = await supabase.from("agent_proposals").update({ status: "rejected", decided_at: new Date().toISOString() }).eq("workspace_id", workspace.id).in("id", same).in("status", ["proposed", "failed"]);
      if (dismissed.error) throw new Error(dismissed.error.message);
      replaced = same.length;
    }
  }
  return { proposalId: data.id as string, title: sentence(payload.direction, payload.person, formatted), replaced };
}

/** Looks for bank transactions that repay an open IOU and proposes each one once, whatever its later outcome. */
export async function proposeRepayments({ supabase, workspace, chatRequestId }: Context) {
  const { data: rows, error } = await supabase.from("wealth_items").select("id, kind, name, currency_code, amount_minor::text, as_of, version, removed_at, linked_account_id")
    .eq("workspace_id", workspace.id).is("removed_at", null).is("linked_account_id", null).in("kind", ["asset", "debt"]).limit(1000);
  if (error) throw new Error(error.message);
  const items = (rows ?? []) as IouItem[];
  if (!items.length) return [];
  const since = items.reduce((min, item) => item.as_of < min ? item.as_of : min, items[0].as_of);
  const recent = await supabase.from("transactions").select("id, description, amount_minor::text, currency_code, posted_on").eq("workspace_id", workspace.id).eq("status", "posted")
    .gte("posted_on", since).order("posted_on", { ascending: false }).limit(2000);
  if (recent.error) throw new Error(recent.error.message);
  const matches = repaymentMatches(items, recent.data ?? []);
  if (!matches.length) return [];
  const keys = matches.map(match => `iou_settle:${match.itemId}:${match.transactionId}`);
  const known = await supabase.from("agent_proposals").select("conflict_key").eq("workspace_id", workspace.id).is("run_id", null).in("conflict_key", keys);
  if (known.error) throw new Error(known.error.message);
  const seen = new Set((known.data ?? []).map(row => row.conflict_key));
  const byTransaction = new Map((recent.data ?? []).map(transaction => [transaction.id, transaction]));
  const fresh = matches.flatMap((match, index) => {
    const transaction = byTransaction.get(match.transactionId)!, item = items.find(candidate => candidate.id === match.itemId)!;
    if (seen.has(keys[index])) return [];
    const applied = formatMoney(match.appliedMinor, item.currency_code, workspace.locale), owed = formatMoney(match.owedMinor, item.currency_code, workspace.locale);
    return [{ workspace_id: workspace.id, agent: "chat", kind: "iou_settle", ...(chatRequestId ? { chat_request_id: chatRequestId } : {}),  conflict_key: keys[index], confidence: match.appliedMinor === match.owedMinor ? 90 : 70,
      title: (match.direction === "lent" ? `${match.person} paid you ${applied}` : `You paid ${match.person} ${applied}`).slice(0, 200),
      detail: `“${transaction.description}” on ${transaction.posted_on}. Counting it against ${owed} still ${match.direction === "lent" ? "owed to you" : "owed by you"}.`,
      evidence: { facts: [], transactions: [{ id: transaction.id, date: transaction.posted_on, description: transaction.description, amountMinor: transaction.amount_minor, currency: transaction.currency_code }], links: [] },
      payload: { itemId: match.itemId, transactionId: match.transactionId, appliedMinor: match.appliedMinor } }];
  });
  if (!fresh.length) return [];
  const inserted = await supabase.from("agent_proposals").insert(fresh).select("id, title");
  // A concurrent run inserted the same match first; its proposals are the ones to show.
  if (inserted.error && inserted.error.code !== "23505") throw new Error(inserted.error.message);
  return inserted.data ?? [];
}

/**
 * Ids of the bank transactions that paid out a recorded IOU (e.g. the transfer that lent Bilal €1,000) or repaid one. Each IOU is read as
 * first recorded in Wealth, so a later repayment or a full settlement does not lose its payout.
 */
export async function loadLoanPayoutIds(supabase: SupabaseClient, workspaceId: string): Promise<Set<string>> {
  const events = await supabase.from("wealth_events").select("item_id, after").eq("workspace_id", workspaceId).is("undone_at", null).order("created_at").limit(2000);
  if (events.error) throw new Error(events.error.message);
  const loans = new Map<string, LoanStart>();
  for (const { item_id, after } of (events.data ?? []) as { item_id: string; after: { name?: string; amount_minor?: string | number; currency_code?: string; as_of?: string } }[]) {
    const parsed = parseIouName(String(after?.name ?? ""));
    if (loans.has(item_id) || !parsed || after.amount_minor === undefined || !after.currency_code || !after.as_of) continue;
    const amount = BigInt(after.amount_minor);
    loans.set(item_id, { ...parsed, amountMinor: amount < 0n ? -amount : amount, currencyCode: after.currency_code, date: String(after.as_of).slice(0, 10) });
  }
  // Accepted repayments are loan money too.
  const settled = await supabase.from("agent_proposals").select("payload").eq("workspace_id", workspaceId).eq("kind", "iou_settle").eq("status", "accepted").limit(1000);
  if (settled.error) throw new Error(settled.error.message);
  const repaid = (settled.data ?? []).map(row => row.payload?.transactionId).filter((id): id is string => typeof id === "string");
  if (!loans.size) return new Set(repaid);
  const amounts = [...new Set([...loans.values()].map(loan => (loan.direction === "lent" ? -loan.amountMinor : loan.amountMinor).toString()))];
  const rows = await supabase.from("transactions").select("id, description, amount_minor::text, currency_code, posted_on").eq("workspace_id", workspaceId).neq("status", "voided")
    .in("amount_minor", amounts.slice(0, 200)).limit(2000);
  if (rows.error) throw new Error(rows.error.message);
  return new Set([...loanPayouts([...loans.values()], rows.data ?? []), ...repaid]);
}

/** Open standalone IOU proposals, oldest first. */
export async function openIouProposals(supabase: SupabaseClient, workspaceId: string) {
  const { data, error } = await supabase.from("agent_proposals").select("id, kind, title, detail, evidence").eq("workspace_id", workspaceId).is("run_id", null)
    .in("kind", ["iou_create", "iou_settle"]).in("status", ["proposed", "failed"]).order("created_at").limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; kind: "iou_create" | "iou_settle"; title: string; detail: string; evidence: { transactions?: { id: string }[] } }[];
}
