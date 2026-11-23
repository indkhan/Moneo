import { z } from "zod";
import { INSIGHT_TYPES } from "@/lib/insight-types";

import { AI_AGENT_KEYS, AI_DATA_SCOPES, DEFAULT_VOICE, SPEECH_ENGINES, VOICES, deviceTimeZone, type AiAgent, type AiDataScope } from "@/lib/workspace-settings-options";

export * from "@/lib/workspace-settings-options";

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

export function aiScopeGuard(settings: WorkspaceSettings | undefined) {
  return (...scopes: AiDataScope[]) => requireAiScope(settings, ...scopes);
}

export function requireAiScope(settings: WorkspaceSettings | undefined, ...scopes: AiDataScope[]) {
  for (const scope of scopes) if (!(settings ?? DEFAULT_SETTINGS).ai_data_scopes.includes(scope))
    throw new Error(`AI access to ${scope} is disabled in Settings`);
}
