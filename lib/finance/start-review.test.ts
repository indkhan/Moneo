import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { start } from "workflow/api";
import { startFinancialReview } from "./start-review";
import {resolveReviewRequest} from "./review-request";
const state = vi.hoisted(() => ({ status: "queued", workflow_run_id: null as string | null, runtimeStatus: "running", registerError: false, started: true }));
vi.mock("workflow/api", () => ({ start: vi.fn(async () => ({runId: "run"})), getRun: () => ({ get exists() { return Promise.resolve(true); }, get status() { return Promise.resolve(state.runtimeStatus); } }) }));
vi.mock("@/workflows/financial-review", () => ({ financialReview: vi.fn() }));
const service = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({createClient: () => service}));
beforeEach(() => {
  Object.assign(state, { status: "queued", workflow_run_id: null, runtimeStatus: "running", registerError: false, started: true });
  vi.clearAllMocks();
  const query = { select: () => query, eq: () => query, in: () => query, single: async () => ({data: {...state, id: "job"}, error: null}) };
  service.from.mockReturnValue(query);
  service.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "register_financial_review_run") {
      if (state.registerError) return {error: new Error("receipt write failed")};
      state.workflow_run_id ??= args.p_run_id as string;
      return {data: state.workflow_run_id === args.p_run_id, error: null};
    }
    if (name === "fail_financial_review") { state.status = "failed"; return {data: "failed", error: null}; }
    return {data: {started: state.started, jobId: "job", status: state.status}, error: null};
  });
});
const db = service as unknown as SupabaseClient;
it("claims the frozen question scope before dispatching and preserves chat identity", async () => {
  const specification = resolveReviewRequest({version: 1, question: "Review September subscriptions"}, "2026-10-07");
  await startFinancialReview(db, "workspace", "request", "chat", specification);
  expect(service.rpc).toHaveBeenCalledWith("start_financial_investigation", {p_request_id: "request", p_chat_request_id: "chat", p_specification: specification});
});
it("acknowledges an actual runtime identity and reuses it on repeated requests", async () => {
  expect(await startFinancialReview(db, "workspace", "request", "chat")).toEqual({jobId: "job", status: "queued"});
  expect(state.workflow_run_id).toBe("run");
  state.started = false;
  await startFinancialReview(db, "workspace", "request", "chat");
  expect(start).toHaveBeenCalledTimes(1);
  expect(service.rpc).toHaveBeenCalledWith("start_financial_review", {p_request_id: "request", p_chat_request_id: "chat"});
});
it("dispatches an existing queued claim without a runtime receipt", async () => {
  state.started = false;
  await startFinancialReview(db, "workspace", "request");
  expect(start).toHaveBeenCalledTimes(1);
});
it("leaves an ambiguous dispatch failure recoverable", async () => {
  vi.mocked(start).mockRejectedValueOnce(new Error("response lost"));
  await expect(startFinancialReview(db, "workspace", "request")).rejects.toThrow();
  expect(state.status).toBe("queued");
  state.started = false;
  await startFinancialReview(db, "workspace", "request");
  expect(state.workflow_run_id).toBe("run");
});
it("checks dispatch receipt writes and later recovers the worker's receipt", async () => {
  state.registerError = true;
  await expect(startFinancialReview(db, "workspace", "request")).rejects.toThrow();
  state.registerError = false; state.started = false; state.workflow_run_id = "run";
  await startFinancialReview(db, "workspace", "request");
  expect(start).toHaveBeenCalledTimes(1);
});
it("reconciles an exhausted runtime whose cleanup never committed", async () => {
  state.started = false; state.workflow_run_id = "run"; state.runtimeStatus = "failed"; state.status = "running";
  expect(await startFinancialReview(db, "workspace", "request")).toEqual({jobId: "job", status: "failed"});
  expect(start).not.toHaveBeenCalled();
});
it("uses the installed runtime's cancelled terminal status", async () => {
  state.started = false; state.workflow_run_id = "run"; state.runtimeStatus = "cancelled"; state.status = "running";
  expect(await startFinancialReview(db, "workspace", "request")).toEqual({jobId: "job", status: "failed"});
  expect(start).not.toHaveBeenCalled();
});
