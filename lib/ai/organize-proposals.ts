import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { answerQuestion, setMemory } from "@/lib/organize/owner";
import { SOURCES, SOURCE_LABEL, loadDecisions, loadMemory, loadNames, loadOpenQuestions } from "@/lib/organize/surfaces";
import { formatMoney } from "@/lib/finance/format";

type Context = { supabase: SupabaseClient; workspace: { id: string; timezone: string; locale: string }; chatRequestId?: string };

export const organizeReviewSchema = z.object({
  view: z.enum(["questions", "decisions", "memory"]).describe("questions: what the organizer is asking the owner; decisions: rows it, a rule, a confirmed payee or the bank's data labelled; memory: what the owner told it each payee is"),
  source: z.enum(SOURCES).optional().describe("decisions only: who labelled the rows"),
}).strict();

/** The organizer's work as the owner sees it on the Organize page, with the ids a card needs. Read-only. */
export async function organizeReview({ supabase, workspace }: Context, input: z.infer<typeof organizeReviewSchema>) {
  const names = await loadNames(supabase, workspace.id);
  if (input.view === "questions") {
    const questions = await loadOpenQuestions(supabase, workspace.id, 20, 4);
    return { questions: questions.map(item => ({ questionId: item.id, identityId: item.identityId, payee: item.identityName, question: item.question, rows: item.transactionIds.length, stillBlank: item.blank,
      examples: item.rows.map(row => ({ id: row.id, date: row.posted_on, description: row.description, amountFormatted: formatMoney(row.amount_minor, row.currency_code, workspace.locale) })) })) };
  }
  if (input.view === "memory") {
    const memory = await loadMemory(supabase, workspace.id);
    return { memory: memory.slice(0, 50).map(item => ({ memoryId: item.id, identityId: item.identityId, payee: item.identityName, category: item.categoryId && names.categories.get(item.categoryId), merchant: item.merchantId && names.merchants.get(item.merchantId),
      purpose: item.purpose, saidBy: item.source === "owner" ? "owner" : "organizer", rows: item.covered })) };
  }
  const { decisions, total } = await loadDecisions(supabase, workspace.id, { source: input.source, pageSize: 30 });
  return { total, showing: decisions.length, decisions: decisions.map(row => ({ id: row.id, date: row.posted_on, description: row.description, amountFormatted: formatMoney(row.amount_minor, row.currency_code, workspace.locale),
    category: row.category_id && names.categories.get(row.category_id), merchant: row.merchant_id && names.merchants.get(row.merchant_id), decidedBy: SOURCE_LABEL[row.source], confidence: row.ai_confidence, reason: row.ai_reason })) };
}

/** What the model asks for: an open question or a payee, and an existing category or merchant by name. */
export const organizeInputSchema = z.object({
  questionId: z.uuid().optional().describe("An open question's id from organize_review"),
  identityId: z.uuid().optional().describe("The payee's id from organize_review; needed only without a questionId"),
  category: z.string().trim().min(1).max(100).optional().describe("An existing category's name"),
  merchant: z.string().trim().min(1).max(100).optional().describe("An existing merchant's name"),
}).strict().refine(input => input.questionId || input.identityId, "Give the question or the payee").refine(input => input.category || input.merchant, "Give a category or a merchant");

export const organizeAnswerSchema = z.object({ questionId: z.uuid().nullable(), identityId: z.uuid(), categoryId: z.uuid().nullable(), merchantId: z.uuid().nullable() }).strict();

const named = <T extends { id: string; name: string }>(list: T[], text: string | undefined, what: string) => {
  if (!text) return null;
  const match = list.find(item => item.name.toLocaleLowerCase("en") === text.toLocaleLowerCase("en"));
  if (!match) throw new Error(`There is no ${what} called "${text}". Only existing ones can be used; tell the owner to add it first.`);
  return match;
};

/** Stores a pending "label this payee's rows" proposal. Nothing is labelled until the owner accepts. */
export async function proposeOrganizeAnswer({ supabase, workspace, chatRequestId }: Context, input: z.infer<typeof organizeInputSchema>) {
  const [names, open] = await Promise.all([loadNames(supabase, workspace.id), input.questionId
    ? supabase.from("organize_questions").select("id, identity_id, transaction_ids").eq("workspace_id", workspace.id).eq("status", "open").eq("id", input.questionId)
    : supabase.from("organize_questions").select("id, identity_id, transaction_ids").eq("workspace_id", workspace.id).eq("status", "open").eq("identity_id", input.identityId!)]);
  if (open.error) throw new Error(open.error.message);
  const question = open.data?.[0] as { id: string; identity_id: string | null; transaction_ids: string[] } | undefined;
  if (input.questionId && !question) throw new Error("That question is not open any more");
  const identityId = question?.identity_id ?? input.identityId;
  if (!identityId) throw new Error("This question has no payee yet, so give the payee's identityId or have the owner label its rows in Transactions");
  const identity = await supabase.from("organize_identities").select("display_name").eq("workspace_id", workspace.id).eq("id", identityId).maybeSingle();
  if (identity.error || !identity.data) throw new Error("Payee not found");
  const category = named(names.categoryList, input.category, "category"), merchant = named(names.merchantList, input.merchant, "merchant");
  const payload = organizeAnswerSchema.parse({ questionId: question?.id ?? null, identityId, categoryId: category?.id ?? null, merchantId: merchant?.id ?? null });
  const who = String(identity.data.display_name);
  const title = `Label ${who} as ${[category?.name, merchant?.name].filter(Boolean).join(" · ")}`.slice(0, 200);
  const detail = `Applies to its rows that are blank or labelled by the AI${question ? `, ${question.transaction_ids.length} in this question` : ""}, and is remembered for its future payments.`;
  const { data, error } = await supabase.from("agent_proposals").insert({ workspace_id: workspace.id, agent: "chat", kind: "organize_answer", ...(chatRequestId ? { chat_request_id: chatRequestId } : {}),
    conflict_key: `organize_answer:${crypto.randomUUID()}`, title, detail, payload, confidence: 100 }).select("id").single();
  if (error) throw new Error(error.message);
  return { proposalId: data.id as string, title };
}

/** Accepting is the owner pressing the card: the same audited calls as the Organize page, so the labels can be undone there. */
export async function applyOrganizeAnswer({ supabase }: Context, payload: unknown) {
  const parsed = organizeAnswerSchema.parse(payload);
  if (parsed.questionId) await answerQuestion(supabase, { questionId: parsed.questionId, identityId: parsed.identityId, categoryId: parsed.categoryId, merchantId: parsed.merchantId });
  else await setMemory(supabase, { identityId: parsed.identityId, categoryId: parsed.categoryId, merchantId: parsed.merchantId, applyToExisting: true });
  return { href: "/money/organize", undo: parsed.questionId ? "Undo from AI organizer → Needs you" : "Undo from the transactions" };
}
