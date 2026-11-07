"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { APICallError, generateText } from "ai";
import { requireWorkspace } from "@/lib/auth";
import { AI_AGENT_KEYS, settingsSchema } from "@/lib/settings";
import { modelForSettings } from "@/lib/ai/provider";
import { minorDigits } from "@/lib/finance/fx";
import { revokeBankSessions } from "@/lib/bank/server";

export type SaveSettingsState = { error?: string; field?: string; saved?: boolean };

export async function saveSettings(_previous: SaveSettingsState, form: FormData): Promise<SaveSettingsState> {
  let field: string | undefined;
  try {
    const { supabase, workspace, settings: previous } = await requireWorkspace();
    const settings = settingsSchema.parse({
      timezone: form.get("timezone"), locale: form.get("locale"), theme: form.get("theme"), voice: form.get("voice"),
      ai_models: Object.fromEntries(AI_AGENT_KEYS.map(agent => [agent, String(form.get(`model:${agent}`) ?? "").trim()]).filter(([, model]) => model)),
      ai_data_scopes: form.getAll("ai_data_scopes"), muted_insight_types: form.getAll("muted_insight_types"),
      summary_cadence: form.get("summary_cadence"), summary_time: form.get("summary_time"),
    });
    field = "display_currency";
    const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a three-letter currency code, such as EUR").parse(form.get("display_currency"));
    minorDigits(currency);
    // Typed models are free text, so each newly changed one must answer before it is saved.
    for (const agent of AI_AGENT_KEYS) {
      if (!settings.ai_models[agent] || settings.ai_models[agent] === previous?.ai_models[agent]) continue;
      field = `model:${agent}`;
      const check = await generateText({ model: await modelForSettings(settings, agent), prompt: "Reply with the single word OK.",
        maxOutputTokens: 512, maxRetries: 0, abortSignal: AbortSignal.timeout(15000) })
        .catch(error => APICallError.isInstance(error) && error.statusCode === 429 ? "rate-limited" as const : null);
      // A rate-limited model exists and answers later; only a missing or silent one blocks saving.
      if (check === "rate-limited") continue;
      if (!check?.text.trim()) throw new Error(`Model "${settings.ai_models[agent]}" did not respond; check the name and its API key`);
    }
    field = undefined;
    const result = await supabase.rpc("save_workspace_preferences", { p_workspace_id: workspace.id, p_display_currency: currency, p_preferences: settings });
    if (result.error) throw new Error("Preferences could not be saved; your previous settings are preserved");
    (await cookies()).set("moneo-theme", settings.theme, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 31536000 });
    revalidatePath("/", "layout");
    return { saved: true };
  } catch (error) {
    const zodField = error instanceof z.ZodError ? error.issues[0]?.path[0] : undefined;
    return { error: error instanceof z.ZodError ? error.issues.map(issue => issue.message).join(". ") : error instanceof Error ? error.message : "Preferences could not be saved",
      field: typeof zodField === "string" ? zodField : field };
  }
}

// Storage RLS is keyed to the current workspace folder, so files go first while it is still ours.
// ponytail: a failure after this leaves rows pointing at removed files; retrying clears them.
async function removeWorkspaceFiles({ supabase, workspace }: Awaited<ReturnType<typeof requireWorkspace>>) {
  for (const bucket of ["imports", "chat"]) {
    for (;;) {
      const listed = await supabase.storage.from(bucket).list(workspace.id, { limit: 1000 });
      if (listed.error) throw listed.error;
      if (!listed.data.length) break;
      const removed = await supabase.storage.from(bucket).remove(listed.data.map(file => `${workspace.id}/${file.name}`));
      if (removed.error) throw removed.error;
      if (!removed.data.length) break; // RLS-denied removes return nothing; never spin
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
