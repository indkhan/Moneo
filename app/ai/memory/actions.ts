"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { safely, type SafeState } from "@/lib/safe-action";
import { calendarDate } from "@/lib/finance/calendar";
import { MEMORY_KINDS } from "@/lib/ai/memory-note";

const memoryId = (form: FormData) => z.uuid().parse(form.get("memory"));
const optionalDay = z.union([z.iso.date(), z.literal("")]).transform(value => value || null);

type Workspace = Awaited<ReturnType<typeof requireWorkspace>>;
async function call(rpc: (context: Workspace) => PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await rpc(await requireWorkspace());
  if (error) throw new Error(error.message);
  revalidatePath("/ai/memory");
}

async function end(form: FormData) {
  await call(({ supabase, settings }) => supabase.rpc("end_memory", { p_id: memoryId(form), p_ended_on: calendarDate(new Date(), settings.timezone), p_today: calendarDate(new Date(), settings.timezone) }));
}
async function forget(form: FormData) { await call(({ supabase }) => supabase.rpc("forget_memory", { p_id: memoryId(form) })); }
async function decline(form: FormData) { await call(({ supabase }) => supabase.rpc("decline_memory", { p_id: memoryId(form) })); }
async function undo(form: FormData) { await call(({ supabase }) => supabase.rpc("undo_memory", { p_id: memoryId(form) })); }
async function confirm(form: FormData) {
  await call(({ supabase, settings }) => supabase.rpc("confirm_memory", { p_id: memoryId(form), p_today: calendarDate(new Date(), settings.timezone) }));
}
async function edit(form: FormData) {
  const input = z.object({
    kind: z.enum(MEMORY_KINDS), statement: z.string().trim().min(3, "Write what Moneo should remember").max(300),
    from: optionalDay, until: optionalDay,
  }).refine(value => !value.from || !value.until || value.until >= value.from, "The end date is before the start date")
    .parse({ kind: form.get("kind"), statement: form.get("statement"), from: form.get("from") ?? "", until: form.get("until") ?? "" });
  await call(({ supabase }) => supabase.rpc("edit_memory", { p_id: memoryId(form), p_kind: input.kind, p_statement: input.statement, p_valid_from: input.from, p_valid_until: input.until }));
}

export const endMemorySafely = async (_state: SafeState, form: FormData) => safely(form, end);
export const forgetMemorySafely = async (_state: SafeState, form: FormData) => safely(form, forget);
export const declineMemorySafely = async (_state: SafeState, form: FormData) => safely(form, decline);
export const undoMemorySafely = async (_state: SafeState, form: FormData) => safely(form, undo);
export const confirmMemorySafely = async (_state: SafeState, form: FormData) => safely(form, confirm);
export const editMemorySafely = async (_state: SafeState, form: FormData) => safely(form, edit);
