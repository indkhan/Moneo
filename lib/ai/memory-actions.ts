"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";

const ids = z.array(z.uuid()).min(1).max(60);

export async function loadMemoryStatuses(memoryIds: string[]) {
  const { supabase, workspace } = await requireWorkspace();
  const { data, error } = await supabase.from("memories").select("id, status").eq("workspace_id", workspace.id).in("id", ids.parse(memoryIds));
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).map(row => [row.id, row.status])) as Record<string, string>;
}

async function memoryCall(name: "undo_memory" | "confirm_memory", memoryId: string) {
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc(name, { p_id: z.uuid().parse(memoryId) });
  if (error) throw new Error(error.message);
  revalidatePath("/ai/memory");
}

export async function undoMemory(memoryId: string) { await memoryCall("undo_memory", memoryId); }
export async function confirmMemory(memoryId: string) { await memoryCall("confirm_memory", memoryId); }
