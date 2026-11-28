"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { LOG_RETENTIONS } from "@/lib/logs/options";
import { deleteAllLogs } from "@/lib/logs/store";
import { safely, type SafeState } from "@/lib/safe-action";

async function setLogRetention(form: FormData) {
  const { supabase, workspace, settings } = await requireWorkspace();
  const preferences = { ...settings, log_retention: z.enum(LOG_RETENTIONS, { error: "Choose how long to keep logs" }).parse(form.get("log_retention")) };
  const { error } = await supabase.rpc("save_workspace_preferences", { p_workspace_id: workspace.id, p_display_currency: workspace.display_currency, p_preferences: preferences });
  if (error) throw new Error("The setting could not be saved. Try again.");
  revalidatePath("/settings/diagnostics");
}

async function removeAllLogs(form: FormData) {
  if (!z.literal("DELETE").safeParse(form.get("confirmation")).success) throw new Error("Type DELETE to confirm");
  const { supabase, workspace } = await requireWorkspace();
  await deleteAllLogs(supabase, workspace.id);
  revalidatePath("/settings/diagnostics");
}

export async function setLogRetentionSafely(_state: SafeState, form: FormData) { return safely(form, setLogRetention); }
export async function deleteAllLogsSafely(_state: SafeState, form: FormData) { return safely(form, removeAllLogs); }
