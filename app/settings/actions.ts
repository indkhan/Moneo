"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { AI_AGENT_KEYS, settingsSchema } from "@/lib/settings";
import { minorDigits } from "@/lib/finance/fx";
import { revokeBankSessions } from "@/lib/bank/server";

export type SaveSettingsState = { error?: string; field?: string; saved?: boolean };

export async function saveSettings(_previous: SaveSettingsState, form: FormData): Promise<SaveSettingsState> {
  let field: string | undefined;
  try {
    const { supabase, workspace } = await requireWorkspace();
    const settings = settingsSchema.parse({
      timezone: form.get("timezone"), locale: form.get("locale"), theme: form.get("theme"), voice: form.get("voice"), speech_engine: form.get("speech_engine") ?? undefined,
      speech_local_model: String(form.get("speech_local_model") ?? "").trim() || null,
      speech_openrouter_model: String(form.get("speech_openrouter_model") ?? "").trim() || null,
      ai_models: Object.fromEntries(["default", ...AI_AGENT_KEYS].map(agent => [agent, String(form.get(`model:${agent}`) ?? "").trim()]).filter(([, model]) => model)),
      ai_data_scopes: form.getAll("ai_data_scopes"), muted_insight_types: form.getAll("muted_insight_types"),
      summary_cadence: form.get("summary_cadence"), summary_time: form.get("summary_time"),
      artifact_scalable_data: form.get("artifact_scalable_data") === "live" ? "live" : "snapshot",
    });
    field = "display_currency";
    const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a three-letter currency code, such as EUR").parse(form.get("display_currency"));
    minorDigits(currency);
    field = undefined;
    const result = await supabase.rpc("save_workspace_preferences", { p_workspace_id: workspace.id, p_display_currency: currency, p_preferences: settings });
    if (result.error) {
      console.error("Preferences save failed", { code: result.error.code });
      throw new Error("Preferences could not be saved. Run setup to apply database updates, then try again.");
    }
    (await cookies()).set("moneo-theme", settings.theme, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 31536000 });
    revalidatePath("/", "layout");
    return { saved: true };
  } catch (error) {
    const zodField = error instanceof z.ZodError ? error.issues[0]?.path[0] : undefined;
    return { error: error instanceof z.ZodError ? error.issues.map(issue => issue.message).join(". ") : error instanceof Error ? error.message : "Preferences could not be saved",
      field: typeof zodField === "string" ? zodField : field };
  }
}

async function removeWorkspaceFiles({ supabase, workspace }: Awaited<ReturnType<typeof requireWorkspace>>) {
  for (const bucket of ["imports", "chat"]) {
    for (;;) {
      const listed = await supabase.storage.from(bucket).list(workspace.id, { limit: 1000 });
      if (listed.error) throw listed.error;
      if (!listed.data.length) break;
      const removed = await supabase.storage.from(bucket).remove(listed.data.map(file => `${workspace.id}/${file.name}`));
      if (removed.error) throw removed.error;
      if (!removed.data.length) break;
    }
  }
}

export async function resetAllData(_previous: { error?: string }, form: FormData): Promise<{ error?: string }> {
  try {
    const context = await requireWorkspace();
    if (!z.literal("RESET").safeParse(form.get("confirmation")).success) return { error: "Type RESET to confirm" };
    await removeWorkspaceFiles(context);
    await revokeBankSessions(context.workspace.id);
    const result = await context.supabase.rpc("reset_workspace");
    if (result.error) throw result.error;
  } catch {
    return { error: "Your data could not be reset completely. Some files or bank connections may already be gone, so try again to finish." };
  }
  revalidatePath("/", "layout");
  redirect("/");
}
