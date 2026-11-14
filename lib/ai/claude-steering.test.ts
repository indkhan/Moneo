import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A Claude Code run that stays open until the test ends it, and records what it was handed.
const run = vi.hoisted(() => ({ settings: undefined as Record<string, unknown> | undefined, finish: undefined as unknown as () => void, fail: undefined as unknown as (error: Error) => void }));
vi.mock("ai-sdk-provider-claude-code", () => ({
  createAiSdkMcpServer: () => ({}),
  claudeCode: (modelId: string, settings: Record<string, unknown>) => ({
    provider: "claude-code", modelId,
    doStream: async () => ({ stream: new ReadableStream({ start: controller => { run.finish = () => controller.close(); run.fail = error => controller.error(error); run.settings = settings; } }) }),
    doGenerate: async () => ({}),
  }),
}));

const { claudeModel } = await import("./claude");

// What the adapter hands to onStreamStart: messages reach the query until the session ends.
function fakeInjector() {
  const injected: string[] = [];
  let closed = false;
  return { injected, get closed() { return closed; }, inject: (content: string, onResult?: (delivered: boolean) => void) => { if (!closed) injected.push(content); onResult?.(!closed); }, close: () => { closed = true; } };
}

async function startRun(steering: Parameters<typeof claudeModel>[2], abortSignal?: AbortSignal) {
  const model = claudeModel("claude-opus-5-5", {}, steering);
  const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }], abortSignal } as Parameters<typeof model.doStream>[0]);
  const injector = fakeInjector();
  (run.settings!.onStreamStart as (injector: unknown) => void)(injector);
  return { injector, stream };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("hands a steer taken during the answer to Claude once, and reports only that it was delivered", async () => {
  const pending = [{ id: "s1", content: "Use March instead" }];
  const take = vi.fn(async () => pending.splice(0));
  const delivered = vi.fn();
  const { injector, stream } = await startRun({ take, delivered });
  expect(run.settings).toMatchObject({ streamingInput: "always" });
  await vi.advanceTimersByTimeAsync(1500);
  await vi.advanceTimersByTimeAsync(3000);
  expect(injector.injected).toEqual(["Use March instead"]);
  expect(delivered).toHaveBeenCalledTimes(1);
  expect(delivered).toHaveBeenCalledWith([{ id: "s1", content: "Use March instead" }]);
  run.finish();
  await stream.getReader().read();
});

it("stops polling when the answer ends, fails or is canceled, and drops a steer taken as it ends", async () => {
  for (const ending of ["finish", "fail", "abort"] as const) {
    const abort = new AbortController();
    let release!: (steers: { id: string; content: string }[]) => void;
    const take = vi.fn(() => new Promise<{ id: string; content: string }[]>(resolve => { release = resolve; }));
    const delivered = vi.fn();
    const { injector, stream } = await startRun({ take, delivered }, abort.signal);
    const reader = stream.getReader();
    await vi.advanceTimersByTimeAsync(1500);
    expect(take).toHaveBeenCalledTimes(1);
    // The claim is still in flight when the answer ends.
    if (ending === "finish") { run.finish(); await reader.read(); }
    if (ending === "fail") { run.fail(new Error("boom")); await expect(reader.read()).rejects.toThrow("boom"); }
    if (ending === "abort") abort.abort();
    release([{ id: "late", content: "Too late" }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(take).toHaveBeenCalledTimes(1);
    expect(injector.injected).toEqual([]);
    expect(delivered).not.toHaveBeenCalled();
    expect(injector.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  }
});

it("leaves other callers alone: no steering means no streaming input", async () => {
  const model = claudeModel("claude-opus-5-5", {});
  await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] } as Parameters<typeof model.doStream>[0]);
  expect(run.settings).not.toHaveProperty("streamingInput");
  expect(run.settings).not.toHaveProperty("onStreamStart");
  run.finish();
});
