import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

export const AI_DATA_SCOPES = ["accounts", "transactions", "planning", "imports"] as const;
export const INSIGHT_TYPES = ["spending_changes", "budget_pressure", "unusual_activity", "recurring_changes", "upcoming_obligations",
  "cash_shortfall", "goal_progress", "asset_debt", "data_quality"] as const;
export type AiDataScope = typeof AI_DATA_SCOPES[number];

export const settingsSchema = z.object({
  timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Choose a valid timezone").default("Europe/Berlin"),
  locale: z.string().max(50).refine(value => { try { return Intl.DateTimeFormat.supportedLocalesOf([value]).length === 1; } catch { return false; } }, "Choose a supported locale").default("en-GB"),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  openrouter_model: z.string().trim().min(1).max(200).nullable().default(null),
  ai_data_scopes: z.array(z.enum(AI_DATA_SCOPES)).max(AI_DATA_SCOPES.length).default([...AI_DATA_SCOPES]),
  muted_insight_types: z.array(z.enum(INSIGHT_TYPES)).max(INSIGHT_TYPES.length).default([]),
  summary_cadence: z.enum(["none", "weekly", "monthly"]).default("none"),
  summary_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
});
export type WorkspaceSettings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS = settingsSchema.parse({});

export async function loadWorkspaceSettings(supabase: SupabaseClient, workspaceId: string): Promise<WorkspaceSettings> {
  const { data, error } = await supabase.from("workspace_settings").select("*").eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw new Error("Workspace preferences unavailable");
  return settingsSchema.parse(data ?? {});
}

export function requireAiScope(settings: WorkspaceSettings | undefined, ...scopes: AiDataScope[]) {
  for (const scope of scopes) if (!(settings ?? DEFAULT_SETTINGS).ai_data_scopes.includes(scope))
    throw new Error(`AI access to ${scope} is disabled in Settings`);
}
