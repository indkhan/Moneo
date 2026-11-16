"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { safely, type SafeState } from "@/lib/safe-action";
import { confirmLabels, removeMemory, setMemory, undoAnswer, undoLabels } from "@/lib/organize/owner";

const choice = z.union([z.uuid(), z.literal("")]).transform(value => value || null);
const done = (tab: string, params: Record<string, string | number> = {}): never => {
  revalidatePath("/", "layout");
  redirect(`/money/organize?${new URLSearchParams({ tab, ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])) })}`);
};

async function undoAnswerAction(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  await undoAnswer(supabase, workspace.id, z.uuid().parse(form.get("batch")));
  done("memory", { undoneAnswer: 1 });
}
export const undoAnswerSafely = async (_state: SafeState, form: FormData) => safely(form, undoAnswerAction);

async function undo(form: FormData) {
  const { supabase } = await requireWorkspace();
  const ops = z.array(z.uuid()).min(1).max(500).parse(form.getAll("op"));
  const result = await undoLabels(supabase, ops);
  done("decided", { undone: result.undone, skipped: result.skipped });
}
export const undoSafely = async (_state: SafeState, form: FormData) => safely(form, undo);

async function confirm(form: FormData) {
  const { supabase } = await requireWorkspace();
  const rows = z.array(z.uuid()).min(1).max(500).parse(form.getAll("row"));
  done("decided", { confirmed: await confirmLabels(supabase, rows) });
}
export const confirmSafely = async (_state: SafeState, form: FormData) => safely(form, confirm);

async function editMemory(form: FormData) {
  const { supabase } = await requireWorkspace();
  const input = z.object({ identity: z.uuid(), category: choice, merchant: choice, purpose: z.string().trim().max(200) }).parse(Object.fromEntries(form));
  if (!input.category && !input.merchant && !input.purpose) throw new Error("Choose a category, a merchant or a purpose");
  await setMemory(supabase, { identityId: input.identity, categoryId: input.category, merchantId: input.merchant, purpose: input.purpose || null, applyToExisting: false });
  done("memory", { saved: 1 });
}
export const editMemorySafely = async (_state: SafeState, form: FormData) => safely(form, editMemory);

async function remove(form: FormData) {
  const { supabase } = await requireWorkspace();
  await removeMemory(supabase, z.uuid().parse(form.get("memory")));
  done("memory", { removed: 1 });
}
export const removeMemorySafely = async (_state: SafeState, form: FormData) => safely(form, remove);
