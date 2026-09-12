import { describe, expect, it } from "vitest";
import {
  JobCancelledError,
  runDurableJob,
  type DurableJob,
  type DecideRetry,
  type HandlerContext,
  type JobAttempt,
  type JobHandler,
  type JobStore,
} from "./job-lifecycle.js";

/**
 * Issue 2.6 — durable job execution lifecycle.
 *
 * A fake store records every call in order, so each test asserts the exact
 * lifecycle sequence plus the attempt history the Epoch 2 acceptance gate
 * requires: success, duplicate delivery of finished work, cancellation
 * before/during execution, retryable vs final failure, unknown types, and
 * missing jobs.
 */

const noRetry: DecideRetry = () => ({ retry: false });

function memoryJobStore(initial: DurableJob[] = []) {
  const jobs = new Map(initial.map((j) => [j.id, { ...j }]));
  const attempts: JobAttempt[] = [];
  const calls: string[] = [];
  let heartbeats = 0;
  const store: JobStore & {
    calls: string[];
    attempts: JobAttempt[];
    job(id: string): DurableJob | undefined;
    heartbeats(): number;
  } = {
    calls,
    attempts,
    job: (id: string) => jobs.get(id),
    heartbeats: () => heartbeats,
    load: (jobId: string) => Promise.resolve(jobs.get(jobId) ? { ...jobs.get(jobId)! } : null),
    createAttempt: (jobId: string, attemptNumber: number) => {
      calls.push(`createAttempt#${attemptNumber}`);
      attempts.push({ jobId, attemptNumber, status: "started", error: null });
      return Promise.resolve();
    },
    markRunning: (jobId: string, _workerId: string, attemptNumber: number) => {
      calls.push(`markRunning#${attemptNumber}`);
      jobs.get(jobId)!.status = "running";
      return Promise.resolve();
    },
    heartbeat: (_jobId: string, _attemptNumber: number) => {
      heartbeats += 1;
      return Promise.resolve();
    },
    finishAttempt: (jobId: string, attemptNumber: number, status, error) => {
      calls.push(`finishAttempt#${attemptNumber}:${status}`);
      attempts.find((a) => a.jobId === jobId && a.attemptNumber === attemptNumber)!.status = status;
      attempts.find((a) => a.jobId === jobId && a.attemptNumber === attemptNumber)!.error = error;
      return Promise.resolve();
    },
    markSucceeded: (jobId: string, _result: Record<string, unknown>) => {
      calls.push("markSucceeded");
      jobs.get(jobId)!.status = "succeeded";
      return Promise.resolve();
    },
    markRetryable: (jobId: string, attemptsMade: number, _runAfter: Date, _error) => {
      calls.push("markRetryable");
      jobs.get(jobId)!.status = "queued";
      jobs.get(jobId)!.attempts = attemptsMade;
      return Promise.resolve();
    },
    markFailed: (jobId: string, attemptsMade: number, _error) => {
      calls.push("markFailed");
      jobs.get(jobId)!.status = "failed";
      jobs.get(jobId)!.attempts = attemptsMade;
      return Promise.resolve();
    },
    markCancelled: (jobId: string, attemptsMade: number) => {
      calls.push("markCancelled");
      jobs.get(jobId)!.status = "cancelled";
      jobs.get(jobId)!.attempts = attemptsMade;
      return Promise.resolve();
    },
  };
  return store;
}

function job(id: string, overrides: Partial<DurableJob> = {}): DurableJob {
  return {
    id,
    workspaceId: "ws-1",
    type: "report.build",
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    payload: { report: "weekly" },
    ...overrides,
  };
}

describe("durable job execution lifecycle", () => {
  it("runs load → attempt → running → execute → success in order", async () => {
    const store = memoryJobStore([job("j1")]);
    const seen: { payload: unknown; ctx: { jobId: string; attemptNumber: number } }[] = [];
    const handlers = new Map<string, JobHandler>([
      [
        "report.build",
        (payload: Record<string, unknown>, ctx: HandlerContext) => {
          seen.push({ payload, ctx: { jobId: ctx.jobId, attemptNumber: ctx.attemptNumber } });
          return ctx.heartbeat().then(() => ({ pages: 4 }));
        },
      ],
    ]);

    const outcome = await runDurableJob(store, handlers, noRetry, "j1", "worker-a");

    expect(outcome).toEqual({ status: "succeeded", attemptNumber: 1 });
    expect(store.calls).toEqual([
      "createAttempt#1",
      "markRunning#1",
      "finishAttempt#1:succeeded",
      "markSucceeded",
    ]);
    expect(store.heartbeats()).toBe(1);
    expect(seen).toEqual([
      { payload: { report: "weekly" }, ctx: { jobId: "j1", attemptNumber: 1 } },
    ]);
    expect(store.job("j1")?.status).toBe("succeeded");
    expect(store.attempts).toEqual([
      { jobId: "j1", attemptNumber: 1, status: "succeeded", error: null },
    ]);
  });

  it("duplicate delivery of finished work does nothing (no new attempt)", async () => {
    const store = memoryJobStore([job("j1", { status: "succeeded", attempts: 1 })]);
    let handlerCalls = 0;
    const handlers = new Map<string, JobHandler>([
      [
        "report.build",
        () => {
          handlerCalls += 1;
          return Promise.resolve({});
        },
      ],
    ]);

    const outcome = await runDurableJob(store, handlers, noRetry, "j1", "worker-b");

    expect(outcome).toEqual({ status: "skipped", reason: "terminal", attemptNumber: null });
    expect(handlerCalls).toBe(0);
    expect(store.calls).toEqual([]);
    expect(store.attempts).toEqual([]);
  });

  it("skips cancelled jobs before creating an attempt", async () => {
    const store = memoryJobStore([job("j1", { status: "cancelled" })]);
    const handlers = new Map<string, JobHandler>([["report.build", () => Promise.resolve({})]]);
    const outcome = await runDurableJob(store, handlers, noRetry, "j1", "worker-a");
    expect(outcome).toEqual({
      status: "skipped",
      reason: "cancelled-before-start",
      attemptNumber: null,
    });
    expect(store.calls).toEqual([]);
  });

  it("skips missing jobs (dangling deliveries after retention cleanup)", async () => {
    const store = memoryJobStore();
    const outcome = await runDurableJob(store, new Map(), noRetry, "ghost", "worker-a");
    expect(outcome).toEqual({ status: "skipped", reason: "not-found", attemptNumber: null });
  });

  it("records retryable failures and requeues with an incremented attempt", async () => {
    const store = memoryJobStore([job("j1")]);
    const handlers = new Map<string, JobHandler>([
      ["report.build", () => Promise.reject(new Error("transient blip"))],
    ]);
    const retryOnce: DecideRetry = (_error, attemptsMade, max) => ({
      retry: attemptsMade < max,
      runAfter: new Date("2026-09-12T00:01:00Z"),
    });

    const outcome = await runDurableJob(store, handlers, retryOnce, "j1", "worker-a");

    expect(outcome).toEqual({ status: "failed", attemptNumber: 1, retried: true });
    expect(store.calls).toEqual([
      "createAttempt#1",
      "markRunning#1",
      "finishAttempt#1:failed",
      "markRetryable",
    ]);
    expect(store.job("j1")).toMatchObject({ status: "queued", attempts: 1 });
    expect(store.attempts[0]).toMatchObject({
      attemptNumber: 1,
      status: "failed",
      error: { name: "Error", message: "transient blip" },
    });
  });

  it("records final failures without requeueing", async () => {
    const store = memoryJobStore([job("j1", { attempts: 2 })]);
    const handlers = new Map<string, JobHandler>([
      ["report.build", () => Promise.reject(new Error("bad input"))],
    ]);
    const retryOnce: DecideRetry = (_error, attemptsMade, max) => ({
      retry: attemptsMade < max,
    });
    const outcome = await runDurableJob(store, handlers, retryOnce, "j1", "worker-a");
    expect(outcome).toEqual({ status: "failed", attemptNumber: 3, retried: false });
    expect(store.calls).toEqual([
      "createAttempt#3",
      "markRunning#3",
      "finishAttempt#3:failed",
      "markFailed",
    ]);
    expect(store.job("j1")?.status).toBe("failed");
  });

  it("treats a Stop arriving mid-run as cancelled", async () => {
    const store = memoryJobStore([job("j1")]);
    const handlers = new Map<string, JobHandler>([
      [
        "report.build",
        (_payload, ctx) =>
          ctx.heartbeat().then(() => {
            throw new JobCancelledError("stop requested");
          }),
      ],
    ]);
    const outcome = await runDurableJob(store, handlers, noRetry, "j1", "worker-a");
    expect(outcome).toEqual({ status: "cancelled", attemptNumber: 1 });
    expect(store.calls).toEqual([
      "createAttempt#1",
      "markRunning#1",
      "finishAttempt#1:failed",
      "markCancelled",
    ]);
    expect(store.job("j1")?.status).toBe("cancelled");
  });

  it("notices external cancellation even when the handler throws something else", async () => {
    const store = memoryJobStore([job("j1")]);
    const handlers = new Map<string, JobHandler>([
      ["report.build", () => Promise.reject(new Error("mid-run failure"))],
    ]);
    // Flip the row to cancelled between load and error handling.
    const cancelling = {
      ...store,
      load: (jobId: string) =>
        store.load(jobId).then((current) => {
          if (current && store.calls.includes("markRunning#1")) {
            return { ...current, status: "cancelled" as const };
          }
          return current;
        }),
    };
    const outcome = await runDurableJob(cancelling, handlers, noRetry, "j1", "worker-a");
    expect(outcome).toEqual({ status: "cancelled", attemptNumber: 1 });
    expect(store.calls).toContain("markCancelled");
  });

  it("fails unknown job types without hanging", async () => {
    const store = memoryJobStore([job("j1", { type: "mystery.job" })]);
    const outcome = await runDurableJob(store, new Map(), noRetry, "j1", "worker-a");
    expect(outcome).toEqual({ status: "failed", attemptNumber: 1, retried: false });
    expect(store.attempts[0]?.error).toMatchObject({
      message: 'no handler registered for job type "mystery.job"',
    });
  });

  it("keeps attempt history across attempts (the audit trail)", async () => {
    const store = memoryJobStore([job("j1")]);
    const flaky = new Map<string, JobHandler>([
      [
        "report.build",
        (_payload, ctx) =>
          ctx.attemptNumber === 1
            ? Promise.reject(new Error("first try fails"))
            : Promise.resolve({ ok: true }),
      ],
    ]);
    const retryOnce: DecideRetry = () => ({ retry: true });
    await runDurableJob(store, flaky, retryOnce, "j1", "worker-a");
    const second = await runDurableJob(store, flaky, retryOnce, "j1", "worker-a");
    expect(second).toEqual({ status: "succeeded", attemptNumber: 2 });
    expect(store.attempts.map((a) => `${a.attemptNumber}:${a.status}`)).toEqual([
      "1:failed",
      "2:succeeded",
    ]);
  });
});
