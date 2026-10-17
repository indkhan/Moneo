"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { APICallError, generateText } from "ai";
import { requireWorkspace } from "@/lib/auth";
import { settingsSchema } from "@/lib/settings";
import { listFreeModels, modelForSettings } from "@/lib/ai/provider";
import { minorDigits } from "@/lib/finance/fx";
import { revokeBankSessions } from "@/lib/bank/server";

export async function saveSettings(_previous: { error?: string; saved?: boolean }, form: FormData): Promise<{ error?: string; saved?: boolean }> {
  try {
    const { supabase, workspace, settings: previous } = await requireWorkspace();
    const settings = settingsSchema.parse({
      timezone: form.get("timezone"), locale: form.get("locale"), theme: form.get("theme"),
      openrouter_model: String(form.get("openrouter_model") ?? "").trim() || null,
      ai_data_scopes: form.getAll("ai_data_scopes"), muted_insight_types: form.getAll("muted_insight_types"),
      summary_cadence: form.get("summary_cadence"), summary_time: form.get("summary_time"),
    });
    const currency = z.string().regex(/^[A-Z]{3}$/, "Use a three-letter currency code").parse(form.get("display_currency"));
    minorDigits(currency);
    const modelChanged = settings.openrouter_model !== previous?.openrouter_model;
    if (settings.openrouter_model && modelChanged) {
      if (!(await listFreeModels()).some(model => model.id === settings.openrouter_model))
        throw new Error("Choose a currently verified free model with the required capabilities");
      // Free models are often rate-limited upstream; the catalogue already verified this one, so a 429 must not block saving.
      const check = await generateText({ model: await modelForSettings(settings), prompt: "Reply with the single word OK.",
        maxOutputTokens: 512, maxRetries: 0, abortSignal: AbortSignal.timeout(15000) })
        .catch(error => { if (APICallError.isInstance(error) && error.statusCode === 429) return null; throw error; });
      if (check && !check.text.trim()) throw new Error("The selected free model returned no usable response; choose another model");
    }
    const result = await supabase.rpc("save_workspace_preferences", { p_workspace_id: workspace.id, p_display_currency: currency, p_preferences: settings });
    if (result.error) throw new Error("Preferences could not be saved; your previous settings are preserved");
    (await cookies()).set("moneo-theme", settings.theme, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 31536000 });
    revalidatePath("/", "layout");
    return { saved: true };
  } catch (error) {
    return { error: error instanceof z.ZodError ? error.issues.map(issue => issue.message).join(". ") : error instanceof Error ? error.message : "Preferences could not be saved" };
  }
}

export async function resetAllData(_previous: { error?: string }, form: FormData): Promise<{ error?: string }> {
  try {
    const { supabase, workspace } = await requireWorkspace();
    if (!z.literal("RESET").safeParse(form.get("confirmation")).success) return { error: "Type RESET to confirm" };
    // Storage RLS is keyed to the current workspace folder, so files go first while it is still ours.
    // ponytail: a failed reset after this leaves rows pointing at removed files; retrying the reset clears them.
    for (const bucket of ["imports", "artifacts"]) {
      for (;;) {
        const listed = await supabase.storage.from(bucket).list(workspace.id, { limit: 1000 });
        if (listed.error) throw listed.error;
        if (!listed.data.length) break;
        const removed = await supabase.storage.from(bucket).remove(listed.data.map(file => `${workspace.id}/${file.name}`));
        if (removed.error) throw removed.error;
        if (!removed.data.length) break; // RLS-denied removes return nothing; never spin
      }
    }
    await revokeBankSessions(workspace.id);
    const result = await supabase.rpc("reset_workspace");
    if (result.error) throw result.error;
  } catch {
    return { error: "Your data could not be reset. Try again." };
  }
  revalidatePath("/", "layout");
  redirect("/");
}
