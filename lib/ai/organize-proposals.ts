import type { ReadonlyDb } from "@/lib/database";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setMemory } from "@/lib/organize/owner";
import { SOURCES, SOURCE_LABEL, loadDecisions, loadMemory, loadNames } from "@/lib/organize/surfaces";
import { formatMoney } from "@/lib/finance/format";

type Context = { supabase: SupabaseClient; workspace: { id: string; timezone: string; locale: string }; chatRequestId?: string };

export const organizeReviewSchema = z.object({
  view: z.enum(["decisions", "memory"]).describe("decisions: rows it, a rule, a confirmed payee or the bank's data labelled; memory: what the owner told it each payee is"),
  source: z.enum(SOURCES).optional().describe("decisions only: who labelled the rows"),
}).strict();

export async function organizeReview({ supabase, workspace }: Omit<Context, "supabase"> & { supabase: ReadonlyDb }, input: z.infer<typeof organizeReviewSchema>) {
  const names = await loadNames(supabase, workspace.id);
  if (input.view === "memory") {
    const memory = await loadMemory(supabase, workspace.id);
    return { memory: memory.slice(0, 50).map(item => ({ memoryId: item.id, identityId: item.identityId, payee: item.identityName, category: item.categoryId && names.categories.get(item.categoryId), merchant: item.merchantId && names.merchants.get(item.merchantId),
      purpose: item.purpose, saidBy: item.source === "owner" ? "owner" : "organizer", rows: item.covered })) };
  }
  const { decisions, total } = await loadDecisions(supabase, workspace.id, { source: input.source, pageSize: 30 });
  return { total, showing: decisions.length, decisions: decisions.map(row => ({ id: row.id, identityId: row.identity_id, date: row.posted_on, description: row.description, amountFormatted: formatMoney(row.amount_minor, row.currency_code, workspace.locale),
    category: row.category_id && names.categories.get(row.category_id), merchant: row.merchant_id && names.merchants.get(row.merchant_id), decidedBy: SOURCE_LABEL[row.source], confidence: row.ai_confidence, reason: row.ai_reason })) };
}

export const organizeInputSchema = z.object({
  identityId: z.uuid().describe("The payee's id from organize_review"),
  category: z.string().trim().min(1).max(100).optional().describe("An existing category's name"),
  merchant: z.string().trim().min(1).max(100).optional().describe("An existing merchant's name"),
}).strict().refine(input => input.category || input.merchant, "Give a category or a merchant");

export const organizeAnswerSchema = z.object({ identityId: z.uuid(), categoryId: z.uuid().nullable(), merchantId: z.uuid().nullable() }).strict();

const named = <T extends { id: string; name: string }>(list: T[], text: string | undefined, what: string) => {
  if (!text) return null;
  const match = list.find(item => item.name.toLocaleLowerCase("en") === text.toLocaleLowerCase("en"));
  if (!match) throw new Error(`There is no ${what} called "${text}". Only existing ones can be used; tell the owner to add it first.`);
  return match;
};

export async function proposeOrganizeAnswer({ supabase, workspace, chatRequestId }: Context, input: z.infer<typeof organizeInputSchema>) {
  const [names, identity] = await Promise.all([loadNames(supabase, workspace.id),
    supabase.from("organize_identities").select("display_name").eq("workspace_id", workspace.id).eq("id", input.identityId).maybeSingle()]);
  if (identity.error || !identity.data) throw new Error("Payee not found");
  const category = named(names.categoryList, input.category, "category"), merchant = named(names.merchantList, input.merchant, "merchant");
  const payload = organizeAnswerSchema.parse({ identityId: input.identityId, categoryId: category?.id ?? null, merchantId: merchant?.id ?? null });
  const who = String(identity.data.display_name);
  const title = `Label ${who} as ${[category?.name, merchant?.name].filter(Boolean).join(" · ")}`.slice(0, 200);
  const detail = "Applies to its rows that are blank or labelled by the AI, and is remembered for its future payments.";
  const { data, error } = await supabase.from("agent_proposals").insert({ workspace_id: workspace.id, agent: "chat", kind: "organize_answer", ...(chatRequestId ? { chat_request_id: chatRequestId } : {}),
    conflict_key: `organize_answer:${crypto.randomUUID()}`, title, detail, payload, confidence: 100 }).select("id").single();
  if (error) throw new Error(error.message);
  return { proposalId: data.id as string, title };
}

export async function applyOrganizeAnswer({ supabase }: Context, payload: unknown) {
  const parsed = organizeAnswerSchema.parse(payload);
  await setMemory(supabase, { identityId: parsed.identityId, categoryId: parsed.categoryId, merchantId: parsed.merchantId, applyToExisting: true });
  return { href: "/money/organize?tab=memory", undo: "Undo from the transactions" };
}
