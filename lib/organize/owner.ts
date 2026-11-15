import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const rpc = async <T,>(db: SupabaseClient, name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(error.message);
  return schema.parse(data);
};
const confirmed = z.object({ memoryId: z.uuid(), batchId: z.uuid().nullable(), applied: z.number().int() });
const nothing = z.unknown();

export const setMemory = (db: SupabaseClient, input: { identityId: string; categoryId: string | null; merchantId: string | null; purpose?: string | null; applyToExisting: boolean }) =>
  rpc(db, "confirm_organize_memory", { p_identity: input.identityId, p_category: input.categoryId, p_merchant: input.merchantId, p_apply_to_existing: input.applyToExisting, p_purpose: input.purpose ?? null }, confirmed);

export async function answerQuestion(db: SupabaseClient, input: { questionId: string; identityId: string; categoryId: string | null; merchantId: string | null }) {
  const result = await setMemory(db, { ...input, applyToExisting: true });
  await rpc(db, "answer_organize_question", { p_question: input.questionId, p_status: "answered",
    p_answer: { categoryId: input.categoryId, merchantId: input.merchantId, memoryId: result.memoryId, batchId: result.batchId, applied: result.applied } }, nothing);
  return result;
}

export const dismissQuestion = (db: SupabaseClient, questionId: string) => rpc(db, "answer_organize_question", { p_question: questionId, p_status: "dismissed", p_answer: null }, nothing);

export const removeMemory = (db: SupabaseClient, memoryId: string) => rpc(db, "remove_organize_memory", { p_memory: memoryId }, nothing);

const undoResult = z.object({ undone: z.number().int(), skipped: z.number().int() });
export const undoLabels = (db: SupabaseClient, opIds: string[]) => rpc(db, "undo_ai_organization", { p_op_ids: opIds }, undoResult);

export const confirmLabels = (db: SupabaseClient, transactionIds: string[]) => rpc(db, "confirm_ai_organization", { p_transaction_ids: transactionIds }, z.number().int());

export async function undoAnswer(db: SupabaseClient, workspaceId: string, batchId: string) {
  const batch = await db.from("transaction_batches").select("selection").eq("workspace_id", workspaceId).eq("id", batchId).maybeSingle();
  if (batch.error || !batch.data) throw new Error("This answer was not found");
  const ids = z.array(z.object({ id: z.uuid() })).parse(batch.data.selection).map(row => row.id);
  const current = await db.from("transactions").select("id, version").eq("workspace_id", workspaceId).in("id", ids);
  if (current.error) throw new Error(current.error.message);
  if ((current.data ?? []).length !== ids.length) throw new Error("Some of these rows no longer exist, so the answer cannot be undone as a whole");
  const { error } = await db.rpc("undo_transaction_batch", { p_batch_id: batchId, p_rows: current.data });
  if (error) throw new Error(error.message);
}
