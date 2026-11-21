"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { calendarDate } from "@/lib/finance/calendar";
import type { MemoryKind } from "@/lib/ai/memory-note";

const ids = z.array(z.uuid()).min(1).max(60);
export type NotedMemory = { id: string; kind: MemoryKind; statement: string; status: string };

export async function loadNotedMemories(memoryIds: string[]) {
  const { supabase, workspace } = await requireWorkspace();
  const { data, error } = await supabase.from("memories").select("id, kind, statement, status").eq("workspace_id", workspace.id).in("id", ids.parse(memoryIds));
  if (error) throw new Error(error.message);
  return Object.fromEntries(((data ?? []) as NotedMemory[]).map(row => [row.id, row])) as Record<string, NotedMemory>;
}

async function settle(error: { message: string } | null) {
  if (error) throw new Error(error.message);
  revalidatePath("/ai/memory");
}

export async function undoMemory(memoryId: string) {
  const { supabase } = await requireWorkspace();
  await settle((await supabase.rpc("undo_memory", { p_id: z.uuid().parse(memoryId) })).error);
}

export async function declineMemory(memoryId: string) {
  const { supabase } = await requireWorkspace();
  await settle((await supabase.rpc("decline_memory", { p_id: z.uuid().parse(memoryId) })).error);
}

export async function confirmMemory(memoryId: string) {
  const { supabase, settings } = await requireWorkspace();
  await settle((await supabase.rpc("confirm_memory", { p_id: z.uuid().parse(memoryId), p_today: calendarDate(new Date(), settings.timezone) })).error);
}
