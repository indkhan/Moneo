"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { INSIGHT_TYPES } from "@/lib/settings";
import { insightPreferencesSchema } from "@/lib/finance/insights";
import { parseManualAmount } from "@/app/money/transactions/input";

export async function dismissInsight(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const evidence_key = z.string().regex(/^[0-9a-f]{64}$/).parse(form.get("key"));
  const insight_type = z.enum(INSIGHT_TYPES).parse(form.get("type"));
  const { error } = await supabase.from("insight_dismissals").upsert({ workspace_id: workspace.id, evidence_key, insight_type }, { onConflict: "workspace_id,evidence_key", ignoreDuplicates: true });
  if (error) throw new Error("Could not dismiss insight");
  revalidatePath("/", "layout");
}

export async function restoreInsights() {
  const { supabase, workspace } = await requireWorkspace();
  const { error } = await supabase.from("insight_dismissals").delete().eq("workspace_id", workspace.id);
  if (error) throw new Error("Could not restore insights");
  revalidatePath("/", "layout");
}

export async function saveInsightPreferences(_state: { error?: string; saved?: boolean }, form: FormData): Promise<{ error?: string; saved?: boolean }> {
  try {
    const { supabase, workspace } = await requireWorkspace();
    const parsed = insightPreferencesSchema.parse({ important_only: form.get("importantOnly") === "on",
      currency_code: z.string().parse(form.get("currency")), minimum_change_minor: parseManualAmount(String(form.get("minimumChange") ?? ""), String(form.get("currency"))).toString(),
      upcoming_days: z.coerce.number().parse(form.get("upcomingDays")), max_items: z.coerce.number().parse(form.get("maxItems")) });
    const { error } = await supabase.from("insight_preferences").upsert({ workspace_id: workspace.id, ...parsed, updated_at: new Date().toISOString() });
    if (error) throw new Error("Could not save insight relevance preferences");
    revalidatePath("/", "layout");
    return { saved: true };
  } catch (error) { return { error: error instanceof Error ? error.message : "Could not save insight preferences" }; }
}
