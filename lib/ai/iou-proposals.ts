import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calendarDate } from "@/lib/finance/calendar";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import { iouCreateSchema, repaymentMatches, type IouItem } from "@/lib/finance/iou";
import { wealthAmount } from "@/lib/finance/wealth";

type Context = { supabase: SupabaseClient; workspace: { id: string; timezone: string; locale: string } };

/** The model's view of a new IOU: a decimal amount; the application turns it into exact minor units. */
export const iouInputSchema = z.object({ direction: z.enum(["lent", "borrowed"]).describe("lent: the user gave money to the person; borrowed: the user received money from the person"),
  person: z.string().trim().min(1).max(100), amount: z.string().trim().regex(/^\d{1,15}(\.\d{1,4})?$/).describe("Positive decimal amount, e.g. 500 or 12.50"),
  currency: z.string().regex(/^[A-Z]{3}$/), date: z.iso.date().optional().describe("When the money changed hands; defaults to today") }).strict();

const sentence = (direction: "lent" | "borrowed", person: string, amount: string) => direction === "lent" ? `${person} owes you ${amount}` : `You owe ${person} ${amount}`;

/** Stores a pending "add this loan to Wealth" proposal. Nothing is written to Wealth until the owner accepts. */
export async function proposeIou({ supabase, workspace }: Context, input: z.infer<typeof iouInputSchema>) {
  minorDigits(input.currency);
  const today = calendarDate(new Date(), workspace.timezone);
  const payload = iouCreateSchema.parse({ direction: input.direction, person: input.person, currencyCode: input.currency, date: input.date ?? today,
    amountMinor: wealthAmount(input.amount, input.currency).toString() });
  if (payload.date > today) throw new Error("The date cannot be in the future");
  const formatted = formatMoney(payload.amountMinor, payload.currencyCode, workspace.locale);
  const { data, error } = await supabase.from("agent_proposals").insert({ workspace_id: workspace.id, agent: "chat", kind: "iou_create", conflict_key: `iou_create:${crypto.randomUUID()}`,
    title: sentence(payload.direction, payload.person, formatted), detail: `${payload.direction === "lent" ? "Lent" : "Borrowed"} on ${payload.date}. Added to Wealth and net worth once you accept.`,
    payload, confidence: 100 }).select("id").single();
  if (error) throw new Error(error.message);
  return { proposalId: data.id as string, title: sentence(payload.direction, payload.person, formatted) };
}

/** Looks for bank transactions that repay an open IOU and proposes each one once, whatever its later outcome. */
export async function proposeRepayments({ supabase, workspace }: Context) {
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
    return [{ workspace_id: workspace.id, agent: "chat", kind: "iou_settle", conflict_key: keys[index], confidence: match.appliedMinor === match.owedMinor ? 90 : 70,
      title: `${match.person} ${match.direction === "lent" ? "paid you" : "was paid"} ${applied}`.slice(0, 200),
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

/** Open standalone IOU proposals, oldest first. */
export async function openIouProposals(supabase: SupabaseClient, workspaceId: string) {
  const { data, error } = await supabase.from("agent_proposals").select("id, kind, title, detail, evidence").eq("workspace_id", workspaceId).is("run_id", null)
    .in("kind", ["iou_create", "iou_settle"]).in("status", ["proposed", "failed"]).order("created_at").limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; kind: "iou_create" | "iou_settle"; title: string; detail: string; evidence: { transactions?: { id: string }[] } }[];
}
