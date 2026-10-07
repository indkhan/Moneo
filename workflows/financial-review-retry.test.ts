import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { financialReview } from "./financial-review";
import { loadFinancialReviewEvidence } from "@/lib/finance/review-loader";
import { APICallError, generateText } from "ai";
import { FatalError } from "workflow";

const state = vi.hoisted(() => ({ status: "queued", stage: "queued", cancel_requested: false, runtimeId: "run" as string | null,
  writes: [] as Record<string, unknown>[], writeError: null as null | Error, saveError: null as null | Error, saves: 0 }));
const cancelRuntime = vi.hoisted(() => vi.fn(async () => { expect(state.status).toBe("canceled"); }));
vi.mock("workflow/api", () => ({ getRun: () => ({ cancel: cancelRuntime }) }));
vi.mock("workflow", async original => ({ ...await original<typeof import("workflow")>(),
  getWorkflowMetadata: () => ({ workflowRunId: "run" }), getStepMetadata: () => ({ attempt: 1 }) }));
vi.mock("@/lib/finance/review-loader", () => ({ loadFinancialReviewEvidence: vi.fn(async () => ({ period: { to: "2026-10-06" }, planning: { unavailable: "Synthetic" } })) }));
vi.mock("@/lib/settings", async original => ({ ...await original<typeof import("@/lib/settings")>(),
  loadWorkspaceSettings: async () => ({ ai_data_scopes: ["accounts", "transactions"], timezone: "UTC" }) }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: async () => ({}) }));
vi.mock("ai", async original => ({ ...await original<typeof import("ai")>(), generateText: vi.fn(async () => ({ text: "Synthetic review" })) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "register_financial_review_run") return { data: !state.cancel_requested, error: null };
    if (name === "fail_financial_review") {
      state.writes.push({ status: "failed" });
      if (state.writeError) return { error: state.writeError };
      if (!["completed", "canceled"].includes(state.status)) state.status = state.cancel_requested ? "canceled" : "failed";
      return { data: state.status, error: null };
    }
    if (state.saveError) { const error = state.saveError; state.saveError = null; return { error }; }
    if (state.cancel_requested) state.status = "canceled";
    else if (state.status !== "completed") { state.status = "completed"; state.saves++; }
    return { data: state.status, error: null, args };
  },
  from: () => {
    let patch: Record<string, unknown> | undefined;
    const result = () => {
      if (patch) {
        state.writes.push(patch);
        if (state.writeError) return { data: null, error: state.writeError };
        if (!["queued", "running"].includes(state.status) || state.cancel_requested && patch.status !== "canceled") return { data: null, error: null };
        Object.assign(state, patch);
      }
      return { data: { ...state, workflow_run_id: state.runtimeId, id: "job", display_currency: "EUR" }, error: null };
    };
    const query = { select: () => query, eq: () => query, in: () => query, is: () => query, abortSignal: () => query,
      update: (value: Record<string, unknown>) => { patch = value; return query; },
      single: async () => result(), maybeSingle: async () => result(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve) };
    return query;
  },
}) }));
beforeEach(() => {
  Object.assign(state, { status: "queued", stage: "queued", cancel_requested: false, runtimeId: "run", writes: [], writeError: null, saveError: null, saves: 0 });
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic");
});
afterEach(() => vi.unstubAllEnvs());

it("finalizes an asynchronous evidence rejection after the workflow observes it", async () => {
  vi.mocked(loadFinancialReviewEvidence).mockRejectedValueOnce(new Error("synthetic loader rejection"));
  await expect(financialReview("job", "workspace")).rejects.toThrow("synthetic loader rejection");
  expect(state.status).toBe("failed");
});
it("does not call a provider when the stage write fails", async () => {
  state.writeError = new Error("synthetic write rejection");
  await expect(financialReview("job", "workspace")).rejects.toThrow();
  expect(generateText).not.toHaveBeenCalled();
});
it("does not hide a failed terminal state write", async () => {
  vi.mocked(loadFinancialReviewEvidence).mockImplementationOnce(async () => { state.writeError = new Error("terminal write rejected"); throw new Error("loader rejected"); });
  await expect(financialReview("job", "workspace")).rejects.toThrow("terminal write rejected");
});
it("does not publish after cancellation wins during the provider call", async () => {
  vi.mocked(generateText).mockImplementationOnce(async () => { state.status = "canceled"; state.cancel_requested = true; return { text: "Too late" } as Awaited<ReturnType<typeof generateText>>; });
  await financialReview("job", "workspace");
  expect(state.status).toBe("canceled"); expect(state.saves).toBe(0);
});
it("does not retry provider errors that the installed AI SDK classifies as permanent", async () => {
  vi.mocked(generateText).mockRejectedValueOnce(new APICallError({message: "Synthetic authorization failure", url: "https://example.invalid", requestBodyValues: {}, statusCode: 401, isRetryable: false}));
  await expect(financialReview("job", "workspace")).rejects.toBeInstanceOf(FatalError);
  expect(state.status).toBe("failed");
});

it("aborts an active provider request promptly and acknowledges only after it settles", async () => {
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const started = Promise.withResolvers<void>();
  vi.mocked(generateText).mockImplementationOnce(async options => {
    signal = options.abortSignal;
    started.resolve();
    await new Promise<void>(resolve => { release = resolve; });
    // A transport may take time to acknowledge abort: requested remains nonterminal.
    expect(state.status).toBe("running");
    throw signal!.reason ?? new Error("test transport released");
  });
  const work = financialReview("job", "workspace").catch(() => {});
  await started.promise;
  state.cancel_requested = true; state.stage = "cancel_requested";
  await new Promise(resolve => setTimeout(resolve, 1200));
  const aborted = signal!.aborted;
  const pendingStatus = state.status;
  release(); await work;
  expect(aborted).toBe(true);
  expect(pendingStatus).toBe("running");
  expect(state.status).toBe("canceled"); expect(state.saves).toBe(0);
  expect(generateText).toHaveBeenCalledTimes(1);
  expect(cancelRuntime).toHaveBeenCalledTimes(1);
});


it("acknowledges Stop before registration without starting useful work", async () => {
  state.cancel_requested = true;
  await financialReview("job", "workspace");
  expect(state.status).toBe("canceled"); expect(generateText).not.toHaveBeenCalled();
});


it("acknowledges an unregistered canceled delivery without allowing a provider call", async () => {
  state.cancel_requested = true; state.runtimeId = null;
  await financialReview("job", "workspace");
  expect(state.status).toBe("canceled"); expect(generateText).not.toHaveBeenCalled();
});
it("does not let an unelected delivery acknowledge Stop for another active run", async () => {
  state.cancel_requested = true; state.runtimeId = "other-run";
  await financialReview("job", "workspace");
  expect(state.status).toBe("queued"); expect(state.writes).toHaveLength(0); expect(generateText).not.toHaveBeenCalled();
});
