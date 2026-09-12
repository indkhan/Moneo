import { describe, expect, it } from "vitest";
import {
  bugInvariantError,
  ClassifiedError,
  classifyError,
  computeBackoffMs,
  createRetryDecider,
  DEFAULT_RETRY_POLICY,
  isRetryableClass,
  permanentInputError,
  permanentPolicyError,
  planRetry,
  RETRY_CLASSES,
  transientError,
  unknownOutcomeError,
  type RetryPolicy,
} from "./retry.js";
import { runDurableJob, type DurableJob, type JobStore } from "./job-lifecycle.js";

/**
 * Issue 2.7 — classified retry handling.
 *
 * Proves the five classes, explicit-class-wins classification, programmer
 * bugs never retrying, bounded budgets, exponential backoff with jitter
 * bounds and caps, deterministic scheduling, and end-to-end behaviour
 * through the Issue 2.6 lifecycle (transient recovers, permanent fails fast).
 */
describe("retry classification", () => {
  it("declares exactly the five required classes", () => {
    expect([...RETRY_CLASSES].sort()).toEqual(
      [
        "TRANSIENT",
        "PERMANENT_INPUT",
        "PERMANENT_POLICY",
        "UNKNOWN_EXTERNAL_OUTCOME",
        "BUG_INVARIANT",
      ].sort(),
    );
  });

  it("honours explicit classes from ClassifiedError and plain markers", () => {
    expect(classifyError(transientError("blip"))).toBe("TRANSIENT");
    expect(classifyError(permanentInputError("bad row"))).toBe("PERMANENT_INPUT");
    expect(classifyError(permanentPolicyError("denied"))).toBe("PERMANENT_POLICY");
    expect(classifyError(unknownOutcomeError("maybe?"))).toBe("UNKNOWN_EXTERNAL_OUTCOME");
    expect(classifyError(bugInvariantError("unreachable"))).toBe("BUG_INVARIANT");
    const plain = new Error("timeout");
    (plain as Error & { retryClass?: string }).retryClass = "PERMANENT_INPUT";
    expect(classifyError(plain)).toBe("PERMANENT_INPUT");
  });

  it("treats programmer bugs as bugs even with transient-sounding messages", () => {
    expect(classifyError(new TypeError("timeout of undefined"))).toBe("BUG_INVARIANT");
    expect(classifyError(new RangeError("too many retries"))).toBe("BUG_INVARIANT");
    expect(classifyError(new ReferenceError("job is not defined"))).toBe("BUG_INVARIANT");
  });

  it("classifies by message hints", () => {
    expect(classifyError(new Error("connect ETIMEDOUT"))).toBe("TRANSIENT");
    expect(classifyError(new Error("service unavailable, try again"))).toBe("TRANSIENT");
    expect(classifyError(new Error("429 rate limited"))).toBe("TRANSIENT");
    expect(classifyError(new Error("row validation failed"))).toBe("PERMANENT_INPUT");
    expect(classifyError(new Error("invariant violated: negative total"))).toBe("PERMANENT_INPUT");
    expect(classifyError(new Error("forbidden for workspace"))).toBe("PERMANENT_POLICY");
    expect(classifyError(new Error("weird provider response"))).toBe("UNKNOWN_EXTERNAL_OUTCOME");
    expect(classifyError("just a string")).toBe("UNKNOWN_EXTERNAL_OUTCOME");
    expect(classifyError(null)).toBe("UNKNOWN_EXTERNAL_OUTCOME");
  });

  it("maps domain/validation errors to permanent input, forbidden to policy", () => {
    const command = new Error("label must not be empty");
    command.name = "CommandError";
    expect(classifyError(command)).toBe("PERMANENT_INPUT");
    const forbidden = new Error("forbidden: not a member");
    forbidden.name = "DomainError";
    expect(classifyError(forbidden)).toBe("PERMANENT_POLICY");
    const zod = new Error("invalid_type at amount");
    zod.name = "ZodError";
    expect(classifyError(zod)).toBe("PERMANENT_INPUT");
    const cancelled = new Error("stop requested");
    cancelled.name = "JobCancelledError";
    expect(classifyError(cancelled)).toBe("PERMANENT_POLICY");
  });

  it("retries only transient and unknown-outcome classes", () => {
    expect(isRetryableClass("TRANSIENT")).toBe(true);
    expect(isRetryableClass("UNKNOWN_EXTERNAL_OUTCOME")).toBe(true);
    expect(isRetryableClass("PERMANENT_INPUT")).toBe(false);
    expect(isRetryableClass("PERMANENT_POLICY")).toBe(false);
    expect(isRetryableClass("BUG_INVARIANT")).toBe(false);
  });

  it("backs off exponentially with equal jitter inside deterministic bounds", () => {
    const policy: RetryPolicy = { maxAttempts: 8, baseDelayMs: 1_000, maxDelayMs: 60_000 };
    // attempt 1: delay 1000 → [500, 1000]; attempt 3: delay 4000 → [2000, 4000].
    expect(computeBackoffMs(1, policy, () => 0)).toBe(500);
    expect(computeBackoffMs(1, policy, () => 1)).toBe(1000);
    expect(computeBackoffMs(3, policy, () => 0)).toBe(2000);
    expect(computeBackoffMs(3, policy, () => 1)).toBe(4000);
    // attempt 0 / fractions clamp to attempt 1; rand clamps to [0, 1].
    expect(computeBackoffMs(0, policy, () => 0.5)).toBe(computeBackoffMs(1, policy, () => 0.5));
    expect(computeBackoffMs(1, policy, () => 99)).toBe(1000);
    // growth caps at maxDelayMs: attempt 10 wants 512s → capped to 60s → [30s, 60s].
    expect(computeBackoffMs(10, policy, () => 0)).toBe(30_000);
    expect(computeBackoffMs(10, policy, () => 1)).toBe(60_000);
  });

  it("plans retries within budget and stops at the budget edge", () => {
    const now = new Date("2026-09-12T00:00:00Z");
    const plan = planRetry(new Error("timeout"), 1, DEFAULT_RETRY_POLICY, now, () => 0);
    expect(plan.retry).toBe(true);
    expect(plan.retryClass).toBe("TRANSIENT");
    // base 1000 → delay 1000 → jitter 0 → +500ms.
    expect(plan.runAfter?.toISOString()).toBe("2026-09-12T00:00:00.500Z");

    const exhausted = planRetry(new Error("timeout"), 5, DEFAULT_RETRY_POLICY, now, () => 0);
    expect(exhausted).toEqual({ retry: false, retryClass: "TRANSIENT" });

    const permanent = planRetry(new Error("validation failed"), 1, DEFAULT_RETRY_POLICY, now);
    expect(permanent.retry).toBe(false);
    expect(permanent.retryClass).toBe("PERMANENT_INPUT");
    expect(permanent.runAfter).toBeUndefined();
  });

  it("never retries bugs, policy denials, or bad input however much budget remains", () => {
    const now = new Date();
    for (const error of [
      new TypeError("nope"),
      permanentPolicyError("denied"),
      permanentInputError("bad"),
    ]) {
      expect(planRetry(error, 1, DEFAULT_RETRY_POLICY, now).retry).toBe(false);
    }
  });

  it("decider honours the job's own maxAttempts over the policy default", () => {
    const decide = createRetryDecider(DEFAULT_RETRY_POLICY, () => 0);
    // Job allows 1 attempt: a first failure is already final.
    expect(decide(new Error("timeout"), 1, 1)).toEqual({ retry: false });
    // Job allows 3: first failure retries with a scheduled time.
    const plan = decide(new Error("timeout"), 1, 3);
    expect(plan.retry).toBe(true);
    expect(plan.runAfter).toBeInstanceOf(Date);
    expect(decide(permanentInputError("bad"), 1, 10)).toEqual({ retry: false });
  });

  it("recovers transient failures end to end through the job lifecycle", async () => {
    const jobs = new Map<string, DurableJob>([
      [
        "j1",
        {
          id: "j1",
          workspaceId: "ws-1",
          type: "import.process",
          status: "queued",
          attempts: 0,
          maxAttempts: 3,
          payload: {},
        },
      ],
    ]);
    const attempts: number[] = [];
    const store: JobStore = {
      load: (id) => Promise.resolve(jobs.get(id) ? { ...jobs.get(id)! } : null),
      createAttempt: () => Promise.resolve(),
      markRunning: (id) => {
        jobs.get(id)!.status = "running";
        return Promise.resolve();
      },
      heartbeat: () => Promise.resolve(),
      finishAttempt: () => Promise.resolve(),
      markSucceeded: (id) => {
        jobs.get(id)!.status = "succeeded";
        return Promise.resolve();
      },
      markRetryable: (id, n) => {
        jobs.get(id)!.status = "queued";
        jobs.get(id)!.attempts = n;
        return Promise.resolve();
      },
      markFailed: (id, n) => {
        jobs.get(id)!.status = "failed";
        jobs.get(id)!.attempts = n;
        return Promise.resolve();
      },
      markCancelled: (id, n) => {
        jobs.get(id)!.status = "cancelled";
        jobs.get(id)!.attempts = n;
        return Promise.resolve();
      },
    };
    const handlers = new Map([
      [
        "import.process",
        (_payload: Record<string, unknown>, ctx: { attemptNumber: number }) => {
          attempts.push(ctx.attemptNumber);
          return ctx.attemptNumber === 1
            ? Promise.reject(new Error("socket hang up"))
            : Promise.resolve({ rows: 10 });
        },
      ],
    ]);
    const decide = createRetryDecider(DEFAULT_RETRY_POLICY, () => 0);

    const first = await runDurableJob(store, handlers, decide, "j1", "worker-a");
    expect(first).toEqual({ status: "failed", attemptNumber: 1, retried: true });
    const second = await runDurableJob(store, handlers, decide, "j1", "worker-a");
    expect(second).toEqual({ status: "succeeded", attemptNumber: 2 });
    expect(attempts).toEqual([1, 2]);
  });

  it("fails permanent input fast with no second attempt", async () => {
    const job: DurableJob = {
      id: "j1",
      workspaceId: "ws-1",
      type: "import.process",
      status: "queued",
      attempts: 0,
      maxAttempts: 5,
      payload: {},
    };
    let runs = 0;
    const store: JobStore = {
      load: () => Promise.resolve({ ...job, status: runs === 0 ? "queued" : "failed" }),
      createAttempt: () => Promise.resolve(),
      markRunning: () => Promise.resolve(),
      heartbeat: () => Promise.resolve(),
      finishAttempt: () => Promise.resolve(),
      markSucceeded: () => Promise.resolve(),
      markRetryable: () => Promise.resolve(),
      markFailed: () => Promise.resolve(),
      markCancelled: () => Promise.resolve(),
    };
    const handlers = new Map([
      [
        "import.process",
        () => {
          runs += 1;
          return Promise.reject(new ClassifiedError("PERMANENT_INPUT", "row 7: bad date"));
        },
      ],
    ]);
    const outcome = await runDurableJob(store, handlers, createRetryDecider(), "j1", "worker-a");
    expect(outcome).toEqual({ status: "failed", attemptNumber: 1, retried: false });
    expect(runs).toBe(1);
  });
});
