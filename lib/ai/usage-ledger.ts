import { randomUUID } from "node:crypto";
import type { LanguageModelMiddleware } from "ai";
import { serviceDb } from "@/lib/service-db";
import { log } from "@/lib/log";
import type { AiAgent } from "@/lib/settings";
import type { TablesInsert } from "@/lib/database.types";
import { logError } from "@/lib/log";

export const USAGE_SOURCES = ["chatgpt", "claude", "openai", "openrouter", "local", "unknown"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];
export const USAGE_EXTRA_TASKS = ["insights", "voice_summary", "voice_realtime", "voice_transcription", "speech_to_text", "text_to_speech"] as const;
export type UsageTask = AiAgent | (typeof USAGE_EXTRA_TASKS)[number];
export type UsageScope = { workspaceId: string; task: UsageTask; conversationId?: string; jobId?: string; agentRunId?: string };
export type UsageTokens = { input: number | undefined; output: number | undefined; reasoning: number | undefined; cachedInput: number | undefined };
export type UsageOutcome = { status: "succeeded" } | { status: "failed" | "canceled"; error: unknown };
export type UsageCall = { id?: string; modelId: string; source: UsageSource; durationMs: number | null; tokens: UsageTokens | null; audioSeconds: number | null; outcome: UsageOutcome };
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
    ...(call.id ? { id: call.id } : {}), workspace_id: scope.workspaceId, task: scope.task, model_id: call.modelId.slice(0, 200), source: call.source,
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
  logError("ai", "ai_usage_an_ai_call_could_not_be_recorded", "[ai-usage] an AI call could not be recorded", error);
}

export function recordUsage(scope: UsageScope, call: UsageCall, write: UsageWriter = insertUsage): Promise<void> {
  return Promise.resolve().then(() => write(usageRow(scope, call))).then(({ error }) => { if (error) reportUsageWriteFailure(error); }, reportUsageWriteFailure);
}

type ModelUsage = { inputTokens: { total?: number; cacheRead?: number }; outputTokens: { total?: number; reasoning?: number } };
const tokensOf = (usage: ModelUsage): UsageTokens => ({
  input: usage.inputTokens.total, output: usage.outputTokens.total, reasoning: usage.outputTokens.reasoning, cachedInput: usage.inputTokens.cacheRead,
});

type PromptMessage = { role: string; content: unknown };
export type AiReply = { text: string; reasoning: string; toolCalls: { toolName: string; input: unknown }[]; finishReason: string | null };
export type AiTrace = (entry: { usageId: string; scope: UsageScope; modelId: string; outcome: UsageOutcome; prompt: readonly PromptMessage[]; reply: AiReply; durationMs: number }) => void;

const RECENT_MESSAGES = 8;
export function promptForLog(prompt: readonly PromptMessage[]) {
  const system = prompt.filter(message => message.role === "system");
  const rest = prompt.filter(message => message.role !== "system");
  return {
    system_chars: system.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0),
    earlier_messages: Math.max(0, rest.length - RECENT_MESSAGES),
    messages: rest.slice(-RECENT_MESSAGES),
  };
}

export const logAiCall: AiTrace = ({ usageId, scope, modelId, outcome, prompt, reply, durationMs }) => log({
  level: outcome.status === "failed" ? "error" : "info", area: scope.task.startsWith("voice") ? "voice" : "ai", event: `ai.${scope.task}`,
  message: `${scope.task} with ${modelId} ${outcome.status}${reply.toolCalls.length ? `, ${reply.toolCalls.length} tool call${reply.toolCalls.length === 1 ? "" : "s"}` : ""}`,
  details: { model: modelId, durationMs: Math.round(durationMs), finishReason: reply.finishReason, prompt: promptForLog(prompt), reasoning: reply.reasoning || undefined, text: reply.text || undefined,
    toolCalls: reply.toolCalls.length ? reply.toolCalls : undefined, error: outcome.status === "succeeded" ? undefined : outcome.error },
  workspaceId: scope.workspaceId, usageId, conversationId: scope.conversationId, jobId: scope.jobId, agentRunId: scope.agentRunId,
});

type ContentPart = { type: string; text?: string; toolName?: string; input?: unknown };
const replyOf = (content: readonly ContentPart[], finishReason: string | null): AiReply => ({
  text: content.filter(part => part.type === "text").map(part => part.text ?? "").join(""),
  reasoning: content.filter(part => part.type === "reasoning").map(part => part.text ?? "").join(""),
  toolCalls: content.filter(part => part.type === "tool-call").map(part => ({ toolName: part.toolName ?? "unknown", input: part.input })),
  finishReason,
});

const EMPTY_REPLY: AiReply = { text: "", reasoning: "", toolCalls: [], finishReason: null };

export function usageMiddleware(scope: UsageScope, source: UsageSource, write: UsageWriter = insertUsage, trace: AiTrace = logAiCall): LanguageModelMiddleware {
  const record = (modelId: string, started: number, tokens: UsageTokens | null, outcome: UsageOutcome, prompt: readonly PromptMessage[], reply: AiReply) => {
    const id = randomUUID(), durationMs = performance.now() - started;
    void recordUsage(scope, { id, modelId, source, durationMs, tokens, audioSeconds: null, outcome }, write);
    trace({ usageId: id, scope, modelId, outcome, prompt, reply, durationMs });
  };
  return {
    wrapGenerate: async ({ doGenerate, model, params }) => {
      const started = performance.now();
      try {
        const result = await doGenerate();
        record(model.modelId, started, tokensOf(result.usage), { status: "succeeded" }, params.prompt, replyOf(result.content, result.finishReason.unified));
        return result;
      } catch (error) {
        record(model.modelId, started, null, outcomeOf(error), params.prompt, EMPTY_REPLY);
        throw error;
      }
    },
    wrapStream: async ({ doStream, model, params }) => {
      const started = performance.now();
      let streamed: Awaited<ReturnType<typeof doStream>>;
      try { streamed = await doStream(); } catch (error) {
        record(model.modelId, started, null, outcomeOf(error), params.prompt, EMPTY_REPLY);
        throw error;
      }
      let tokens: UsageTokens | null = null, failure: UsageOutcome | null = null, recorded = false, finishReason: string | null = null;
      const parts: ContentPart[] = [];
      const finish = (outcome: UsageOutcome) => {
        if (recorded) return;
        recorded = true;
        record(model.modelId, started, tokens, outcome, params.prompt, replyOf(parts, finishReason));
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
          const part = next.value;
          if (part.type === "text-delta") parts.push({ type: "text", text: part.delta });
          if (part.type === "reasoning-delta") parts.push({ type: "reasoning", text: part.delta });
          if (part.type === "tool-call") parts.push({ type: "tool-call", toolName: part.toolName, input: part.input });
          if (part.type === "finish") { tokens = tokensOf(part.usage); finishReason = part.finishReason.unified; }
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
