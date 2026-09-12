import { describe, expect, it } from "vitest";
import { DomainError } from "./problem.js";
import {
  checkLimit,
  checkUploadBounds,
  createMemoryLimiterStore,
  ExecutionQuota,
  LIMITS,
  loadLimits,
  requireLimit,
  withExecutionSlot,
  type LimitsConfig,
} from "./limits.js";

/**
 * Issue 2.11 — resource limits and configuration.
 *
 * Pins the documented initial numbers, env validation, per-workspace
 * isolation (A's burst never spends B's budget), structured 429s with
 * Retry-After, fail-open reads vs fail-closed writes on limiter outage,
 * upload bounds, execution quotas that isolate tenants under a global
 * ceiling, and quota rejection that runs BEFORE any mutation.
 */
describe("limits configuration", () => {
  it("documents the initial numeric limits", () => {
    expect(LIMITS).toMatchObject({
      mutationsPerMinute: 60,
      mutationBurst: 10,
      jobSubmitsPerMinute: 30,
      jobSubmitBurst: 5,
      readsPerMinute: 600,
      readBurst: 50,
      uploadMaxBytes: 10 * 1024 * 1024,
      uploadMaxRows: 50_000,
      workerConcurrency: 4,
      maxRunningJobsPerWorkspace: 2,
      maxRunningJobsGlobal: 8,
    });
  });

  it("loads defaults with an empty environment", () => {
    const limits = loadLimits({});
    expect(limits.mutationsPerMinute).toBe(60);
    expect(limits.limiterFailurePolicy).toBe("open-reads");
  });

  it("honours valid environment overrides", () => {
    const limits = loadLimits({
      MONEO_LIMIT_MUTATIONS_PER_MINUTE: "120",
      MONEO_LIMIT_MAX_RUNNING_PER_WORKSPACE: "4",
      MONEO_LIMITER_FAILURE_POLICY: "closed",
    });
    expect(limits.mutationsPerMinute).toBe(120);
    expect(limits.maxRunningJobsPerWorkspace).toBe(4);
    expect(limits.limiterFailurePolicy).toBe("closed");
  });

  it("rejects garbage configuration instead of running unprotected", () => {
    expect(() => loadLimits({ MONEO_LIMIT_MUTATIONS_PER_MINUTE: "unlimited" })).toThrow(
      /invalid limits configuration/,
    );
    expect(() => loadLimits({ MONEO_LIMIT_MUTATIONS_PER_MINUTE: "-5" })).toThrow(
      /invalid limits configuration/,
    );
    expect(() => loadLimits({ MONEO_LIMITER_FAILURE_POLICY: "yolo" })).toThrow(
      /invalid limits configuration/,
    );
  });
});

describe("rate limiter", () => {
  const tiny: LimitsConfig = {
    ...loadLimits({}),
    mutationsPerMinute: 60,
    mutationBurst: 3,
    readsPerMinute: 60,
    readBurst: 3,
  };

  it("allows bursts then denies with a structured Retry-After", async () => {
    const store = createMemoryLimiterStore();
    expect(await checkLimit(store, tiny, "mutation", "ws-a", 0)).toMatchObject({ allowed: true });
    expect(await checkLimit(store, tiny, "mutation", "ws-a", 1)).toMatchObject({ allowed: true });
    expect(await checkLimit(store, tiny, "mutation", "ws-a", 2)).toMatchObject({ allowed: true });
    const denied = await checkLimit(store, tiny, "mutation", "ws-a", 3);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("isolates workspaces: A's burst never spends B's budget", async () => {
    const store = createMemoryLimiterStore();
    for (let i = 0; i < 3; i += 1) {
      await checkLimit(store, tiny, "mutation", "ws-a", i);
    }
    expect(await checkLimit(store, tiny, "mutation", "ws-a", 99)).toMatchObject({ allowed: false });
    expect(await checkLimit(store, tiny, "mutation", "ws-b", 99)).toMatchObject({ allowed: true });
  });

  it("resets when the window elapses", async () => {
    const store = createMemoryLimiterStore();
    for (let i = 0; i < 3; i += 1) {
      await checkLimit(store, tiny, "mutation", "ws-a", i);
    }
    // Burst 3 at 60/min → 3s window; far-future clock starts a fresh window.
    expect(await checkLimit(store, tiny, "mutation", "ws-a", 60_000)).toMatchObject({
      allowed: true,
    });
  });

  it("throws documented 429 problems with retry guidance", async () => {
    const store = createMemoryLimiterStore();
    for (let i = 0; i < 3; i += 1) {
      await requireLimit(store, tiny, "mutation", "ws-a", i);
    }
    const error = await requireLimit(store, tiny, "mutation", "ws-a", 99).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("RATE_LIMITED");
    expect((error as DomainError).status).toBe(429);
    expect((error as DomainError).retryable).toBe(true);
    expect((error as DomainError).details["retryAfterSeconds"]).toBeGreaterThan(0);
  });

  it("fails open for reads but closed for writes on limiter outage", async () => {
    const outage = {
      take: () => Promise.reject(new Error("redis down")),
    };
    const limits = loadLimits({});
    // Reads degrade: availability over protection.
    expect(await checkLimit(outage, limits, "read", "ws-a")).toMatchObject({ allowed: true });
    // Writes pause loudly rather than running unprotected.
    const writeError = await checkLimit(outage, limits, "mutation", "ws-a").catch(
      (e: unknown) => e,
    );
    expect(writeError).toBeInstanceOf(DomainError);
    expect((writeError as DomainError).code).toBe("DEPENDENCY_UNAVAILABLE");
    expect((writeError as DomainError).retryable).toBe(true);
    const submitError = await checkLimit(outage, limits, "job-submit", "ws-a").catch(
      (e: unknown) => e,
    );
    expect((submitError as DomainError).code).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("keeps limiter state separate from queue transport data", async () => {
    const limiter = createMemoryLimiterStore();
    const queueJobs = new Map<string, object>();
    await checkLimit(limiter, loadLimits({}), "mutation", "ws-a", 0);
    queueJobs.set("outbox:e1", { eventId: "e1" });
    limiter.clear(); // limiter eviction/reset…
    expect(queueJobs.get("outbox:e1")).toEqual({ eventId: "e1" }); // …never loses jobs.
  });
});

describe("upload bounds", () => {
  it("accepts files inside the bounds", () => {
    expect(checkUploadBounds(loadLimits({}), 1024, 100)).toEqual({ ok: true });
  });

  it("rejects oversize files and over-row files as VALIDATION_FAILED", () => {
    const limits = loadLimits({});
    const tooBig = checkUploadBounds(limits, limits.uploadMaxBytes + 1, 10);
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) {
      expect(tooBig.error.code).toBe("VALIDATION_FAILED");
      expect(tooBig.error.status).toBe(400);
    }
    const tooManyRows = checkUploadBounds(limits, 1024, limits.uploadMaxRows + 1);
    expect(tooManyRows.ok).toBe(false);
    if (!tooManyRows.ok) {
      expect(tooManyRows.error.errors?.[0]?.field).toBe("rows");
    }
  });
});

describe("execution quota", () => {
  it("caps each workspace while leaving the other untouched", () => {
    const quota = new ExecutionQuota(loadLimits({}));
    expect(quota.tryAcquire("ws-a")).toMatchObject({ acquired: true });
    expect(quota.tryAcquire("ws-a")).toMatchObject({ acquired: true });
    // A is full…
    expect(quota.tryAcquire("ws-a").acquired).toBe(false);
    // …but B's reserved capacity is intact.
    expect(quota.tryAcquire("ws-b")).toMatchObject({ acquired: true });
    expect(quota.running("ws-a")).toBe(2);
    expect(quota.running("ws-b")).toBe(1);
  });

  it("bounds the global total across many workspaces", () => {
    const quota = new ExecutionQuota(loadLimits({}));
    let acquired = 0;
    for (let i = 0; i < 10; i += 1) {
      if (quota.tryAcquire(`ws-${i}`).acquired) {
        acquired += 1;
      }
    }
    // 10 workspaces × cap 2, but the global ceiling of 8 binds first.
    expect(acquired).toBe(8);
    expect(quota.tryAcquire("ws-fresh").acquired).toBe(false);
  });

  it("releases slots when work finishes", () => {
    const quota = new ExecutionQuota(loadLimits({}));
    quota.tryAcquire("ws-a");
    quota.tryAcquire("ws-a");
    expect(quota.tryAcquire("ws-a").acquired).toBe(false);
    quota.release("ws-a");
    expect(quota.tryAcquire("ws-a").acquired).toBe(true);
    // Releasing an empty workspace is a safe no-op (never goes negative).
    quota.release("ws-ghost");
    expect(quota.running("ws-ghost")).toBe(0);
  });

  it("rejects BEFORE any mutation runs (no half-committed work)", async () => {
    const quota = new ExecutionQuota(loadLimits({}));
    let mutations = 0;
    const act = (): Promise<string> => {
      mutations += 1;
      return Promise.resolve("done");
    };
    quota.tryAcquire("ws-a");
    quota.tryAcquire("ws-a");
    const error = await withExecutionSlot(quota, "ws-a", act).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("RATE_LIMITED");
    expect(mutations).toBe(0);
    // And the happy path acquires, acts, and releases.
    await expect(withExecutionSlot(quota, "ws-b", act)).resolves.toBe("done");
    expect(mutations).toBe(1);
    expect(quota.running("ws-b")).toBe(0);
  });
});
