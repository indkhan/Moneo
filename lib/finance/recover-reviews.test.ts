import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { start } from "workflow/api";
import { dispatchFinancialReview, recoverFinancialReviews } from "./start-review";

const state = vi.hoisted(() => ({ job: { id: "job", workspace_id: "workspace", status: "queued", stage: "queued", workflow_run_id: null as string | null, created_at: new Date().toISOString(), dispatched_at: new Date().toISOString() as string | null, updated_at: "2026-01-01T00:00:00Z", cancel_requested: false }, runtime: "running", exists: true, scheduled: false, unavailable: false, cancelFails: false, cancelAcknowledged: true, activeStep: false, canceledAt: new Date() }));
vi.mock("workflow/runtime", () => ({ getWorld: () => ({ steps: { list: async () => ({ data: state.activeStep ? [{ status: "running" }] : [], hasMore: false }) } }) }));
const cancel = vi.hoisted(() => vi.fn());
vi.mock("workflow/api", () => ({ start: vi.fn(async () => ({ runId: "run" })), getRun: () => ({ cancel, get exists() { return state.unavailable ? Promise.reject(new Error("runtime unavailable")) : Promise.resolve(state.exists); }, get status() { return Promise.resolve(state.runtime); }, get completedAt() { return Promise.resolve(state.canceledAt); } }) }));
vi.mock("@/workflows/financial-review", () => ({ financialReview: vi.fn() }));
const rpc = vi.fn();
const updates: Record<string, unknown>[] = [];
function from(table: string) {
  let update: Record<string, unknown> | undefined;
  const query = { select: () => query, eq: () => query, is: () => query, in: () => query, order: () => query, update: (value: Record<string, unknown>) => { update = value; return query; },
    limit: async () => ({ data: [{ ...state.job }], error: null, count: 1 }),
    maybeSingle: async () => ({ data: table === "summary_runs" ? state.scheduled ? { cadence: "weekly" } : null : { ...state.job }, error: null }),
    single: async () => ({ data: { ...state.job }, error: null }),
    then: (resolve: (value: unknown) => void) => { if (update) { updates.push(update); Object.assign(state.job, update); } resolve({ error: null }); } };
  return query;
}
const db = { from, rpc } as unknown as SupabaseClient;
beforeEach(() => {
  vi.clearAllMocks(); updates.length = 0;
  Object.assign(state, { runtime: "running", exists: true, scheduled: false, unavailable: false, cancelFails: false, cancelAcknowledged: true, activeStep: false, canceledAt: new Date() });
  Object.assign(state.job, { status: "queued", stage: "queued", workflow_run_id: null, created_at: new Date().toISOString(), dispatched_at: new Date().toISOString(), updated_at: "2026-01-01T00:00:00Z", cancel_requested: false });
  cancel.mockImplementation(async () => { if (state.cancelFails) throw new Error("cancel unavailable"); if (state.cancelAcknowledged) state.runtime = "cancelled"; });
  rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "register_financial_review_run") { state.job.workflow_run_id ??= args.p_run_id as string; return { data: true, error: null }; }
    if (!["completed", "canceled", "failed"].includes(state.job.status)) {
      state.job.status = state.job.cancel_requested ? "canceled" : "failed";
      state.job.stage = state.job.cancel_requested && args.p_stage !== "cancellation_unconfirmed" ? "canceled" : args.p_stage as string;
    }
    return { data: state.job.status, error: null };
  });
});
it("unattended recovery dispatches orphan claims with their original scheduled identity", async () => {
  state.scheduled = true;
  expect(await recoverFinancialReviews(db)).toMatchObject({ recovered: 1, errors: 0 });
  expect(start).toHaveBeenCalledWith(expect.any(Function), ["job", "workspace", true]);
  expect(state.job.workflow_run_id).toBe("run");
});
it("reconciles exhausted cleanup without requiring another manual request", async () => {
  state.job.workflow_run_id = "run"; state.runtime = "failed";
  await recoverFinancialReviews(db);
  expect(state.job.status).toBe("failed"); expect(start).not.toHaveBeenCalled();
});
it("keeps stale running runtime retries alive and rotates them behind other recovery candidates", async () => {
  state.job.workflow_run_id = "run";
  await recoverFinancialReviews(db);
  expect(state.job.status).toBe("queued"); expect(start).not.toHaveBeenCalled();
  expect(updates).toHaveLength(1); expect(state.job.updated_at).not.toBe("2026-01-01T00:00:00Z");
});
it("does not turn runtime unavailability into terminal failure", async () => {
  state.job.workflow_run_id = "run"; state.unavailable = true;
  expect(await recoverFinancialReviews(db)).toMatchObject({ errors: 1 });
  expect(state.job.status).toBe("queued"); expect(rpc).not.toHaveBeenCalled();
});
it("terminates a missing runtime only after the receipt grace period", async () => {
  state.job.workflow_run_id = "run"; state.exists = false;
  state.job.updated_at = new Date().toISOString();
  await dispatchFinancialReview(db, "job", "workspace");
  expect(state.job.status).toBe("queued");
  state.job.updated_at = "2026-01-01T00:00:00Z";
  state.job.dispatched_at = state.job.updated_at;
  await dispatchFinancialReview(db, "job", "workspace");
  expect(state.job.status).toBe("failed"); expect(start).not.toHaveBeenCalled();
});
it("expires a stuck runtime only after cancellation is acknowledged", async () => {
  state.job.workflow_run_id = "run"; state.job.dispatched_at = "2026-01-01T00:00:00Z";
  await recoverFinancialReviews(db);
  expect(cancel).toHaveBeenCalledTimes(1); expect(state.runtime).toBe("cancelled");
  expect(state.job.status).toBe("failed"); expect(start).not.toHaveBeenCalled();
});
it.each(["failure", "unacknowledged"])("keeps deadline cancellation %s recoverable and observable", async mode => {
  state.job.workflow_run_id = "run"; state.job.dispatched_at = "2026-01-01T00:00:00Z";
  state.cancelFails = mode === "failure"; state.cancelAcknowledged = false;
  expect(await recoverFinancialReviews(db)).toMatchObject({ errors: 1 });
  expect(state.job.status).toBe("queued"); expect(rpc).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
});
it("preserves publication that wins the runtime cancellation race", async () => {
  state.job.workflow_run_id = "run"; state.job.dispatched_at = "2026-01-01T00:00:00Z";
  cancel.mockImplementation(async () => { state.runtime = "completed"; state.job.status = "completed"; });
  await recoverFinancialReviews(db);
  expect(state.job.status).toBe("completed"); expect(start).not.toHaveBeenCalled();
});
it("acknowledges cancellation of an orphan without creating provider work", async () => {
  state.job.cancel_requested = true;
  await recoverFinancialReviews(db);
  expect(state.job.status).toBe("canceled"); expect(state.job.stage).toBe("canceled"); expect(start).not.toHaveBeenCalled();
});
it("fails an unacknowledged claim past its business deadline without inventing a runtime identity", async () => {
  state.job.created_at = "2026-01-01T00:00:00Z";
  await recoverFinancialReviews(db);
  expect(state.job.status).toBe("failed"); expect(state.job.workflow_run_id).toBeNull(); expect(start).not.toHaveBeenCalled();
});
it("preserves terminal application states without consulting or restarting runtime", async () => {
  state.job.status = "completed"; state.job.workflow_run_id = "run"; state.unavailable = true;
  expect(await dispatchFinancialReview(db, "job", "workspace")).toMatchObject({ status: "completed" });
  expect(rpc).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
});
it("uses immutable creation time when a legacy receipt lacks dispatch time", async () => {
  state.job.workflow_run_id = "run"; state.job.dispatched_at = null;
  state.job.created_at = "2026-01-01T00:00:00Z"; state.job.updated_at = new Date().toISOString();
  await recoverFinancialReviews(db);
  expect(cancel).toHaveBeenCalledTimes(1); expect(state.job.status).toBe("failed");
});
it("rotates 25 broken runtime candidates so the next scan reaches a healthy orphan", async () => {
  state.unavailable = true;
  const jobs: Record<string, unknown>[] = Array.from({ length: 26 }, (_, index) => ({ ...state.job, kind: "financial_review", id: `job${String(index).padStart(2, "0")}`, workflow_run_id: index < 25 ? `broken${index}` : null }));
  const boundary = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      let update: Record<string, unknown> | undefined;
      const selected = () => jobs.filter(job => filters.every(([key, value]) => job[key] === value));
      const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; }, in: () => query, order: () => query,
        update: (value: Record<string, unknown>) => { update = value; return query; },
        limit: async () => ({ data: selected().sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) || String(a.id).localeCompare(String(b.id))).slice(0, 25).map(job => ({ ...job })), count: selected().length, error: null }),
        single: async () => ({ data: { ...selected()[0] }, error: null }),
        maybeSingle: async () => ({ data: table === "summary_runs" ? null : selected()[0], error: null }),
        then: (resolve: (value: unknown) => void) => { if (update) for (const job of selected()) Object.assign(job, update); resolve({ error: null }); } };
      return query;
    },
    rpc: async (_name: string, args: Record<string, unknown>) => { const job = jobs.find(row => row.id === args.p_job_id)!; job.workflow_run_id = args.p_run_id; job.updated_at = new Date().toISOString(); return { data: true, error: null }; },
  } as unknown as SupabaseClient;
  expect(await recoverFinancialReviews(boundary)).toMatchObject({ scanned: 25, errors: 25, remaining: 1 });
  expect(await recoverFinancialReviews(boundary)).toMatchObject({ recovered: 1, errors: 24 });
  expect(jobs[25].workflow_run_id).toBe("run"); expect(start).toHaveBeenCalledTimes(1);
});

it("does not acknowledge runtime cancellation while its active provider step is still settling", async () => {
  state.job.workflow_run_id = "run"; state.job.status = "running"; state.job.cancel_requested = true;
  state.runtime = "cancelled";
  state.activeStep = true;
  await recoverFinancialReviews(db);
  expect(state.job.status).toBe("running"); expect(rpc).not.toHaveBeenCalled();
});


it("reconciles a canceled runtime after its provider step has settled", async () => {
  state.job.workflow_run_id = "run"; state.job.status = "running"; state.job.cancel_requested = true; state.runtime = "cancelled";
  await recoverFinancialReviews(db);
  expect(state.job.status).toBe("canceled");
});
it("converges a crashed canceled runtime without claiming request termination", async () => {
  state.job.workflow_run_id = "run"; state.job.status = "running"; state.job.cancel_requested = true;
  state.runtime = "cancelled"; state.activeStep = true; state.canceledAt = new Date(Date.now() - 120_001);
  await recoverFinancialReviews(db);
  expect(state.job.status).toBe("canceled"); expect(state.job.stage).toBe("cancellation_unconfirmed"); expect(start).not.toHaveBeenCalled();
});
