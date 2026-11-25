"use server";

import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/auth";

export async function skipAiSetup(): Promise<{ error?: string }> {
  const { supabase, workspace } = await requireWorkspace();
  const { error } = await supabase.from("workspace_settings").update({ ai_setup_skipped_at: new Date().toISOString() }).eq("workspace_id", workspace.id);
  if (error) {
    console.error("skipAiSetup failed", { code: error.code });
    return { error: "Could not save. Try again." };
  }
  revalidatePath("/");
  return {};
}
