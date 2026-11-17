import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

export const AI_DATA_SCOPES = ["accounts", "transactions", "planning", "imports"] as const;
export const INSIGHT_TYPES = ["spending_changes", "budget_pressure", "unusual_activity", "recurring_changes", "upcoming_obligations",
  "cash_shortfall", "goal_progress", "asset_debt", "data_quality"] as const;
export type AiDataScope = typeof AI_DATA_SCOPES[number];
export const AI_AGENTS = {
  chat: { label: "Chat assistant", model: "gpt-6-luna", claude: "claude-opus-5-5" },
  review: { label: "Financial review", model: "gpt-6-luna", claude: "claude-opus-5-5" },
  agents: { label: "Agent team", model: "gpt-6-luna", claude: "claude-haiku-5-5" },
  imports: { label: "Import mapping", model: "gpt-6-luna", claude: "claude-haiku-5-5" },
  organize: { label: "Organization suggestions", model: "gpt-6-luna", claude: "claude-haiku-5-5" },
  artifacts: { label: "Artifact builder", model: "gpt-6-luna", claude: "claude-opus-5-5" },
  titles: { label: "Chat titles", model: "gpt-6-luna", claude: "claude-haiku-5-5" },
  voice_call: { label: "Voice call", model: "gpt-6-luna", claude: "claude-opus-5-5" },
} as const;
export type AiAgent = keyof typeof AI_AGENTS;
export const AI_AGENT_KEYS = Object.keys(AI_AGENTS) as AiAgent[];
export const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;
export const DEFAULT_VOICE = VOICES[0];
export const SPEECH_ENGINES = ["openai", "local", "openrouter"] as const;
export type SpeechEngineId = typeof SPEECH_ENGINES[number];

export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const settingsSchema = z.object({
  timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Choose a valid timezone").default(deviceTimeZone),
  locale: z.string().max(50).refine(value => { try { return Intl.DateTimeFormat.supportedLocalesOf([value]).length === 1; } catch { return false; } }, "Choose a supported locale").default("en-GB"),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  ai_models: z.partialRecord(z.enum(["default", ...AI_AGENT_KEYS] as ["default", ...AiAgent[]]), z.string().trim().min(1).max(200)).default({}),
  voice: z.enum(VOICES).default(DEFAULT_VOICE),
  speech_engine: z.enum(SPEECH_ENGINES).default("openai"),
  speech_local_model: z.string().trim().min(1).max(1000).nullable().default(null),
  speech_openrouter_model: z.string().trim().min(1).max(200).nullable().default(null),
  ai_data_scopes: z.array(z.enum(AI_DATA_SCOPES)).max(AI_DATA_SCOPES.length).default([...AI_DATA_SCOPES]),
  muted_insight_types: z.array(z.enum(INSIGHT_TYPES)).max(INSIGHT_TYPES.length).default([]),
  summary_cadence: z.enum(["none", "weekly", "monthly"]).default("none"),
  summary_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
  artifact_scalable_data: z.enum(["snapshot", "live"]).default("snapshot"),
});
export type WorkspaceSettings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS = settingsSchema.parse({});

export function readSettings(stored: unknown): WorkspaceSettings {
  const whole = settingsSchema.safeParse(stored ?? {});
  if (whole.success) return whole.data;
  console.warn("[workspace-access] settings-invalid");
  const row = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
  const fields = Object.entries(settingsSchema.shape).map(([name, field]) => {
    const read = field.safeParse(row[name]);
    return [name, read.success ? read.data : DEFAULT_SETTINGS[name as keyof WorkspaceSettings]];
  });
  return Object.fromEntries(fields) as WorkspaceSettings;
}

export async function loadWorkspaceSettings(supabase: SupabaseClient, workspaceId: string): Promise<WorkspaceSettings> {
  const { data, error } = await supabase.from("workspace_settings").select("*").eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw new Error("Workspace preferences unavailable");
  return readSettings(data);
}

export function requireAiScope(settings: WorkspaceSettings | undefined, ...scopes: AiDataScope[]) {
  for (const scope of scopes) if (!(settings ?? DEFAULT_SETTINGS).ai_data_scopes.includes(scope))
    throw new Error(`AI access to ${scope} is disabled in Settings`);
}
