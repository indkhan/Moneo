"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { generateText } from "ai";
import { requireWorkspace } from "@/lib/auth";
import { settingsSchema } from "@/lib/settings";
import { listFreeModels, modelForSettings } from "@/lib/ai/provider";
import { minorDigits } from "@/lib/finance/fx";

export async function saveSettings(_previous: { error?: string; saved?: boolean }, form: FormData): Promise<{ error?: string; saved?: boolean }> {
  try {
    const { supabase, workspace } = await requireWorkspace();
    const settings = settingsSchema.parse({
      timezone: form.get("timezone"), locale: form.get("locale"), theme: form.get("theme"),
      openrouter_model: String(form.get("openrouter_model") ?? "").trim() || null,
      ai_data_scopes: form.getAll("ai_data_scopes"), muted_insight_types: form.getAll("muted_insight_types"),
      summary_cadence: form.get("summary_cadence"), summary_time: form.get("summary_time"),
    });
    const currency = z.string().regex(/^[A-Z]{3}$/, "Use a three-letter currency code").parse(form.get("display_currency"));
    minorDigits(currency);
    if (settings.openrouter_model && !(await listFreeModels()).some(model => model.id === settings.openrouter_model))
      throw new Error("Choose a currently verified free model with the required capabilities");
    if (settings.openrouter_model) {
      const check = await generateText({ model: await modelForSettings(settings), prompt: "Reply with the single word OK.",
        maxOutputTokens: 64, maxRetries: 0, abortSignal: AbortSignal.timeout(15000) });
      if (!check.text.trim()) throw new Error("The selected free model returned no usable response; choose another model");
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
