import type { LanguageModelMiddleware } from "ai";
import { serviceDb } from "@/lib/service-db";
import type { AiAgent } from "@/lib/settings";
import type { TablesInsert } from "@/lib/database.types";

export const USAGE_SOURCES = ["chatgpt", "claude", "openai", "openrouter", "local", "unknown"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];
export const USAGE_EXTRA_TASKS = ["insights", "voice_summary", "voice_realtime", "voice_transcription", "speech_to_text", "text_to_speech"] as const;
export type UsageTask = AiAgent | (typeof USAGE_EXTRA_TASKS)[number];
export type UsageScope = { workspaceId: string; task: UsageTask; conversationId?: string; jobId?: string; agentRunId?: string };
export type UsageTokens = { input: number | undefined; output: number | undefined; reasoning: number | undefined; cachedInput: number | undefined };
export type UsageOutcome = { status: "succeeded" } | { status: "failed" | "canceled"; error: unknown };
export type UsageCall = { modelId: string; source: UsageSource; durationMs: number | null; tokens: UsageTokens | null; audioSeconds: number | null; outcome: UsageOutcome };
export type AiUsageRow = TablesInsert<"ai_usage">;
export type UsageWriter = (row: AiUsageRow) => PromiseLike<{ error: unknown }>;

const count = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
const seconds = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : null;

export function errorKind(error: unknown): string {
  if (error && typeof error === "object") {
    const { name, statusCode } = error as { name?: unknown; statusCode?: unknown };
    if (typeof statusCode === "number") return `http_${statusCode}`;
    if (typeof name === "string" && name) return name.slice(0, 100);
  }
  return "unknown";
}

export function outcomeOf(error: unknown): UsageOutcome {
  const aborted = error instanceof Error && error.name === "AbortError";
  return { status: aborted ? "canceled" : "failed", error };
}

export function usageRow(scope: UsageScope, call: UsageCall): AiUsageRow {
  return {
    workspace_id: scope.workspaceId, task: scope.task, model_id: call.modelId.slice(0, 200), source: call.source,
    input_tokens: count(call.tokens?.input), output_tokens: count(call.tokens?.output),
    reasoning_tokens: count(call.tokens?.reasoning), cached_input_tokens: count(call.tokens?.cachedInput),
    audio_seconds: seconds(call.audioSeconds),
    duration_ms: call.durationMs === null ? null : Math.max(0, Math.round(call.durationMs)),
    status: call.outcome.status, error_kind: call.outcome.status === "succeeded" ? null : errorKind(call.outcome.error),
    conversation_id: scope.conversationId ?? null, job_id: scope.jobId ?? null, agent_run_id: scope.agentRunId ?? null,
  };
}

const insertUsage: UsageWriter = row => serviceDb().from("ai_usage").insert(row);

function reportUsageWriteFailure(error: unknown) {
  console.error("[ai-usage] an AI call could not be recorded", error);
}

export function recordUsage(scope: UsageScope, call: UsageCall, write: UsageWriter = insertUsage): Promise<void> {
  return Promise.resolve().then(() => write(usageRow(scope, call))).then(({ error }) => { if (error) reportUsageWriteFailure(error); }, reportUsageWriteFailure);
}

type ModelUsage = { inputTokens: { total?: number; cacheRead?: number }; outputTokens: { total?: number; reasoning?: number } };
const tokensOf = (usage: ModelUsage): UsageTokens => ({
  input: usage.inputTokens.total, output: usage.outputTokens.total, reasoning: usage.outputTokens.reasoning, cachedInput: usage.inputTokens.cacheRead,
});

export function usageMiddleware(scope: UsageScope, source: UsageSource, write: UsageWriter = insertUsage): LanguageModelMiddleware {
  const record = (modelId: string, started: number, tokens: UsageTokens | null, outcome: UsageOutcome) =>
    void recordUsage(scope, { modelId, source, durationMs: performance.now() - started, tokens, audioSeconds: null, outcome }, write);
  return {
    wrapGenerate: async ({ doGenerate, model }) => {
      const started = performance.now();
      try {
        const result = await doGenerate();
        record(model.modelId, started, tokensOf(result.usage), { status: "succeeded" });
        return result;
      } catch (error) {
        record(model.modelId, started, null, outcomeOf(error));
        throw error;
      }
    },
    wrapStream: async ({ doStream, model }) => {
      const started = performance.now();
      let streamed: Awaited<ReturnType<typeof doStream>>;
      try { streamed = await doStream(); } catch (error) {
        record(model.modelId, started, null, outcomeOf(error));
        throw error;
      }
      let tokens: UsageTokens | null = null, failure: UsageOutcome | null = null, recorded = false;
      const finish = (outcome: UsageOutcome) => {
        if (recorded) return;
        recorded = true;
        record(model.modelId, started, tokens, outcome);
      };
      type Part = typeof streamed.stream extends ReadableStream<infer P> ? P : never;
      const reader = streamed.stream.getReader();
      const stream = new ReadableStream<Part>({
        async pull(controller) {
          let next: ReadableStreamReadResult<Part>;
          try { next = await reader.read(); } catch (error) {
            finish(outcomeOf(error));
            controller.error(error);
            return;
          }
          if (next.done) {
            finish(failure ?? { status: "succeeded" });
            controller.close();
            return;
          }
          if (next.value.type === "finish") tokens = tokensOf(next.value.usage);
          if (next.value.type === "error") failure = outcomeOf(next.value.error);
          controller.enqueue(next.value);
        },
        cancel(reason: unknown) {
          finish({ status: "canceled", error: reason });
          return reader.cancel(reason);
        },
      });
      return { ...streamed, stream };
    },
  };
}
