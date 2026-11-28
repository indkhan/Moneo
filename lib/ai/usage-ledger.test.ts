import { describe, expect, it, vi } from "vitest";
import { generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { usageMiddleware, usageRow, type AiUsageRow } from "./usage-ledger";

const scope = { workspaceId: "00000000-0000-4000-8000-000000000001", task: "chat" as const, conversationId: "00000000-0000-4000-8000-000000000002" };
const usage = { inputTokens: { total: 120, noCache: 20, cacheRead: 100, cacheWrite: undefined }, outputTokens: { total: 40, text: 30, reasoning: 10 } };
const generated = { content: [{ type: "text" as const, text: "hi" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };

function recording() {
  const rows: AiUsageRow[] = [];
  const write = vi.fn(async (row: AiUsageRow) => { rows.push(row); return { error: null }; });
  return { rows, write };
}

describe("an AI usage row", () => {
  it("keeps every field and leaves counts the provider did not report empty, never zero", () => {
    const row = usageRow({ ...scope, jobId: "00000000-0000-4000-8000-000000000003" }, {
      modelId: "gpt-test", source: "openai", durationMs: 812.6, audioSeconds: 2.00049,
      tokens: { input: 0, output: undefined, reasoning: 7, cachedInput: -1 }, outcome: { status: "failed", error: { statusCode: 429 } },
    });
    expect(row).toEqual({
      workspace_id: scope.workspaceId, task: "chat", model_id: "gpt-test", source: "openai",
      input_tokens: 0, output_tokens: null, reasoning_tokens: 7, cached_input_tokens: null, audio_seconds: 2,
      duration_ms: 813, status: "failed", error_kind: "http_429",
      conversation_id: scope.conversationId, job_id: "00000000-0000-4000-8000-000000000003", agent_run_id: null,
    });
    expect(usageRow(scope, { modelId: "m", source: "local", durationMs: null, tokens: null, audioSeconds: null, outcome: { status: "succeeded" } }))
      .toMatchObject({ input_tokens: null, output_tokens: null, reasoning_tokens: null, cached_input_tokens: null, audio_seconds: null, duration_ms: null, error_kind: null });
  });
});

describe("recording model calls", () => {
  it("records one row per generated answer with the tokens the provider reported", async () => {
    const { rows, write } = recording();
    const model = wrapLanguageModel({ model: new MockLanguageModelV4({ modelId: "gpt-test", doGenerate: generated }), middleware: usageMiddleware(scope, "chatgpt", write) });
    await generateText({ model, prompt: "hello" });
    await vi.waitFor(() => expect(rows).toHaveLength(1));
    expect(rows[0]).toMatchObject({ model_id: "gpt-test", source: "chatgpt", task: "chat", input_tokens: 120, output_tokens: 40, reasoning_tokens: 10, cached_input_tokens: 100, status: "succeeded", error_kind: null });
  });

  it("records a failed call without counts and still raises the error", async () => {
    const { rows, write } = recording();
    const failure = Object.assign(new Error("rate limited"), { statusCode: 429 });
    const model = wrapLanguageModel({ model: new MockLanguageModelV4({ doGenerate: async () => { throw failure; } }), middleware: usageMiddleware(scope, "openai", write) });
    await expect(generateText({ model, prompt: "hello", maxRetries: 0 })).rejects.toThrow();
    await vi.waitFor(() => expect(rows).toHaveLength(1));
    expect(rows[0]).toMatchObject({ status: "failed", error_kind: "http_429", input_tokens: null, output_tokens: null });
  });

  it("records a streamed answer once it finishes", async () => {
    const { rows, write } = recording();
    const stream = simulateReadableStream({ chunks: [
      { type: "text-start" as const, id: "1" }, { type: "text-delta" as const, id: "1", delta: "hi" }, { type: "text-end" as const, id: "1" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
    ] });
    const model = wrapLanguageModel({ model: new MockLanguageModelV4({ modelId: "claude-test", doStream: { stream } }), middleware: usageMiddleware(scope, "claude", write) });
    const result = streamText({ model, prompt: "hello" });
    expect(await result.text).toBe("hi");
    await vi.waitFor(() => expect(rows).toHaveLength(1));
    expect(rows[0]).toMatchObject({ model_id: "claude-test", source: "claude", input_tokens: 120, output_tokens: 40, status: "succeeded" });
  });

  it("never fails the answer when the usage row cannot be saved", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const model = wrapLanguageModel({ model: new MockLanguageModelV4({ doGenerate: generated }), middleware: usageMiddleware(scope, "openai", async () => ({ error: new Error("database down") })) });
    expect((await generateText({ model, prompt: "hello" })).text).toBe("hi");
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("could not be recorded"), expect.any(Error)));
  });
});
