"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { generateText } from "ai";
import { requireWorkspace } from "@/lib/auth";
import { AI_AGENT_KEYS, settingsSchema } from "@/lib/settings";
import { modelForSettings } from "@/lib/ai/provider";
import { minorDigits } from "@/lib/finance/fx";
import { revokeBankSessions } from "@/lib/bank/server";

export async function saveSettings(_previous: { error?: string; saved?: boolean }, form: FormData): Promise<{ error?: string; saved?: boolean }> {
  try {
    const { supabase, workspace, settings: previous } = await requireWorkspace();
    const settings = settingsSchema.parse({
      timezone: form.get("timezone"), locale: form.get("locale"), theme: form.get("theme"),
      ai_models: Object.fromEntries(AI_AGENT_KEYS.map(agent => [agent, String(form.get(`model:${agent}`) ?? "").trim()]).filter(([, model]) => model)),
      ai_data_scopes: form.getAll("ai_data_scopes"), muted_insight_types: form.getAll("muted_insight_types"),
      summary_cadence: form.get("summary_cadence"), summary_time: form.get("summary_time"),
    });
    const currency = z.string().regex(/^[A-Z]{3}$/, "Use a three-letter currency code").parse(form.get("display_currency"));
    minorDigits(currency);
    // Typed models are free text, so each newly changed one must answer before it is saved.
    for (const agent of AI_AGENT_KEYS) {
      if (!settings.ai_models[agent] || settings.ai_models[agent] === previous?.ai_models[agent]) continue;
      const check = await generateText({ model: await modelForSettings(settings, agent), prompt: "Reply with the single word OK.",
        maxOutputTokens: 512, maxRetries: 0, abortSignal: AbortSignal.timeout(15000) }).catch(() => null);
      if (!check?.text.trim()) throw new Error(`Model "${settings.ai_models[agent]}" did not respond; check the name and your OpenAI key`);
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
