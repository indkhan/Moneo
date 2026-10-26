import { z } from "zod";

export type ReportedUsage = { model_id: string; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null };

export function reportedUsage(modelId: string, usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): ReportedUsage {
  const count = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : null;
  return { model_id: modelId, input_tokens: count(usage.inputTokens), output_tokens: count(usage.outputTokens), total_tokens: count(usage.totalTokens) };
}

export function usageLabel(usage: ReportedUsage | null) {
  return usage ? `${usage.model_id} · input ${usage.input_tokens ?? "unknown"}, output ${usage.output_tokens ?? "unknown"}, total ${usage.total_tokens ?? "unknown"} tokens · cost unknown` : "Token usage and cost unknown";
}

export const usageWindows = ["7d", "30d", "all"] as const;
export type UsageWindow = (typeof usageWindows)[number];

const DAY_MS = 86_400_000;
const windowDays = { "7d": 7, "30d": 30 } as const;

export function parseUsageWindow(value: unknown): UsageWindow {
  return z.enum(usageWindows).catch("30d").parse(value);
}

export function usageSince(window: UsageWindow, now = new Date()) {
  return window === "all" ? null : new Date(now.getTime() - windowDays[window] * DAY_MS).toISOString();
}

const storedUsage = z.object({
  model_id: z.string().min(1).max(200),
  input_tokens: z.number().int().nonnegative().safe().nullish(),
  output_tokens: z.number().int().nonnegative().safe().nullish(),
});

export type ModelUsage = { model_id: string; requests: number; input_tokens: number; output_tokens: number };

// Missing counts are left out of the totals and counted in `unreported`, never treated as zero.
export function usageByModel(rows: { usage: unknown }[]) {
  const models = new Map<string, ModelUsage>();
  let unreported = 0;
  for (const row of rows) {
    const parsed = storedUsage.safeParse(row.usage);
    if (!parsed.success) { unreported++; continue; }
    const { model_id, input_tokens, output_tokens } = parsed.data;
    if (input_tokens == null || output_tokens == null) unreported++;
    const model = models.get(model_id) ?? { model_id, requests: 0, input_tokens: 0, output_tokens: 0 };
    model.requests++;
    model.input_tokens += input_tokens ?? 0;
    model.output_tokens += output_tokens ?? 0;
    models.set(model_id, model);
  }
  const sorted = [...models.values()].sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));
  return { models: sorted, unreported };
}
