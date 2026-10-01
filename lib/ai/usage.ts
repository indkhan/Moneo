export type ReportedUsage = { model_id: string; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null };

export function reportedUsage(modelId: string, usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): ReportedUsage {
  const count = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : null;
  return { model_id: modelId, input_tokens: count(usage.inputTokens), output_tokens: count(usage.outputTokens), total_tokens: count(usage.totalTokens) };
}

export function usageLabel(usage: ReportedUsage | null) {
  return usage ? `${usage.model_id} · input ${usage.input_tokens ?? "unknown"}, output ${usage.output_tokens ?? "unknown"}, total ${usage.total_tokens ?? "unknown"} tokens · cost unknown` : "Token usage and cost unknown";
}
