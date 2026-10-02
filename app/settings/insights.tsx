import { requireWorkspace } from "@/lib/auth";
import { defaultInsightPreferences, insightPreferencesSchema } from "@/lib/finance/insights";
import { InsightsForm } from "./insights-form";

export async function InsightSettings() {
  const { supabase, workspace } = await requireWorkspace();
  const [preferences, dismissed] = await Promise.all([
    supabase.from("insight_preferences").select("important_only,minimum_change_minor::text,currency_code,upcoming_days,max_items").eq("workspace_id", workspace.id).maybeSingle(),
    supabase.from("insight_dismissals").select("evidence_key", { count: "exact", head: true }).eq("workspace_id", workspace.id),
  ]);
  if (preferences.error || dismissed.error) return <p role="alert">Insight preferences are unavailable.</p>;
  const parsed = insightPreferencesSchema.safeParse(preferences.data ?? defaultInsightPreferences(workspace.display_currency));
  if (!parsed.success) return <p role="alert">Saved insight preferences need review.</p>;
  return <InsightsForm preferences={parsed.data} dismissedCount={dismissed.count ?? 0} />;
}
