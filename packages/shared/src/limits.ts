import { z } from "zod";
import { DomainError } from "./problem.js";

/**
 * Issue 2.11 — resource limits and configuration.
 *
 * Initial numeric limits and failure policy (the ticket's contract, kept next
 * to the code so they cannot drift apart):
 *
 *   mutations/writes:      60 / workspace / minute (burst 10). Excess → 429 RATE_LIMITED.
 *   job submissions:       30 / workspace / minute (burst 5).  Excess → 429 RATE_LIMITED.
 *   reads:                 600 / workspace / minute (burst 50). Excess → 429 RATE_LIMITED.
 *   uploads:               10 MiB / file, 50 000 rows / file.   Excess → 400 VALIDATION_FAILED.
 *   worker concurrency:    4 jobs per worker process.
 *   execution quota:       2 concurrently RUNNING jobs / workspace, 8 globally.
 *                            Excess → 429 RATE_LIMITED *before* any row is written,
 *                            so rejection never leaves a half-committed command/job.
 *   limiter failure:       fail CLOSED for writes (deny with 503
 *                            DEPENDENCY_UNAVAILABLE), fail OPEN for reads.
 *                            A broken limiter must never corrupt data, and must
 *                            never silently disable protection for mutations.
 *
 * Out of scope here by design: AI token/cost limits (E6) and artifact
 * CPU/memory limits (E13) extend this file in their epochs.
 *
 * Rate-limit state lives in its OWN store (an in-process Map here, Redis in
 * later epochs) and never shares storage with the durable queue transport:
 * evicting limiter keys cannot lose jobs, and flushing jobs cannot reset
 * limits. The `RateLimiter` takes its store as a constructor argument so the
 * separation is structural, not a comment.
 */

export const LIMITS = {
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
} as const;

const limitsSchema = z.object({
  mutationsPerMinute: z.number().int().positive().default(LIMITS.mutationsPerMinute),
  mutationBurst: z.number().int().positive().default(LIMITS.mutationBurst),
  jobSubmitsPerMinute: z.number().int().positive().default(LIMITS.jobSubmitsPerMinute),
  jobSubmitBurst: z.number().int().positive().default(LIMITS.jobSubmitBurst),
  readsPerMinute: z.number().int().positive().default(LIMITS.readsPerMinute),
  readBurst: z.number().int().positive().default(LIMITS.readBurst),
  uploadMaxBytes: z.number().int().positive().default(LIMITS.uploadMaxBytes),
  uploadMaxRows: z.number().int().positive().default(LIMITS.uploadMaxRows),
  workerConcurrency: z.number().int().positive().default(LIMITS.workerConcurrency),
  maxRunningJobsPerWorkspace: z
    .number()
    .int()
    .positive()
    .default(LIMITS.maxRunningJobsPerWorkspace),
  maxRunningJobsGlobal: z.number().int().positive().default(LIMITS.maxRunningJobsGlobal),
  limiterFailurePolicy: z.enum(["open-reads", "closed"]).default("open-reads"),
});

export type LimitsConfig = z.infer<typeof limitsSchema>;

const envInt = (value: string | undefined): number | undefined => {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
};

/** Validated configuration from environment overrides (throws on garbage). */
export function loadLimits(env: Record<string, string | undefined> = {}): LimitsConfig {
  const parsed = limitsSchema.safeParse({
    mutationsPerMinute: envInt(env["MONEO_LIMIT_MUTATIONS_PER_MINUTE"]),
    mutationBurst: envInt(env["MONEO_LIMIT_MUTATION_BURST"]),
    jobSubmitsPerMinute: envInt(env["MONEO_LIMIT_JOB_SUBMITS_PER_MINUTE"]),
    jobSubmitBurst: envInt(env["MONEO_LIMIT_JOB_SUBMIT_BURST"]),
    readsPerMinute: envInt(env["MONEO_LIMIT_READS_PER_MINUTE"]),
    readBurst: envInt(env["MONEO_LIMIT_READ_BURST"]),
    uploadMaxBytes: envInt(env["MONEO_LIMIT_UPLOAD_MAX_BYTES"]),
    uploadMaxRows: envInt(env["MONEO_LIMIT_UPLOAD_MAX_ROWS"]),
    workerConcurrency: envInt(env["MONEO_LIMIT_WORKER_CONCURRENCY"]),
    maxRunningJobsPerWorkspace: envInt(env["MONEO_LIMIT_MAX_RUNNING_PER_WORKSPACE"]),
    maxRunningJobsGlobal: envInt(env["MONEO_LIMIT_MAX_RUNNING_GLOBAL"]),
    limiterFailurePolicy: env["MONEO_LIMITER_FAILURE_POLICY"],
  });
  if (!parsed.success) {
    throw new Error(
      `invalid limits configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

export type LimitAction = "mutation" | "job-submit" | "read";

const WINDOW_OF: Record<
  LimitAction,
  (limits: LimitsConfig) => { perMinute: number; burst: number }
> = {
  mutation: (l) => ({ perMinute: l.mutationsPerMinute, burst: l.mutationBurst }),
  "job-submit": (l) => ({ perMinute: l.jobSubmitsPerMinute, burst: l.jobSubmitBurst }),
  read: (l) => ({ perMinute: l.readsPerMinute, burst: l.readBurst }),
};

export interface LimiterStore {
  /** Tokens remaining for `key` in the current window (may throw to simulate outage). */
  take(key: string, capacity: number, refillPerMs: number, now: number): Promise<number>;
}

/** Fixed-window in-process store. Production swaps this for Redis; the limiter never touches queue storage. */
export function createMemoryLimiterStore(): LimiterStore & { size(): number; clear(): void } {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    size: () => windows.size,
    clear: () => {
      windows.clear();
    },
    take: (key, capacity, refillPerMs, now) => {
      const windowMs = capacity * refillPerMs;
      const current = windows.get(key);
      if (!current || now >= current.resetAt) {
        const fresh = { count: 1, resetAt: now + windowMs };
        windows.set(key, fresh);
        return Promise.resolve(capacity - 1);
      }
      current.count += 1;
      return Promise.resolve(capacity - current.count);
    },
  };
}

export interface LimitCheck {
  allowed: boolean;
  /** Seconds until the caller may retry (set when denied). */
  retryAfterSeconds: number;
}

/**
 * Check one action for one workspace. Denials become structured 429s with
 * Retry-After; a broken store follows the configured fail policy instead of
 * failing open for writes.
 */
export async function checkLimit(
  store: LimiterStore,
  limits: LimitsConfig,
  action: LimitAction,
  workspaceId: string,
  now: number = Date.now(),
): Promise<LimitCheck> {
  const { perMinute, burst } = WINDOW_OF[action](limits);
  const refillPerMs = 60_000 / perMinute;
  try {
    const remaining = await store.take(`rl:${action}:${workspaceId}`, burst, refillPerMs, now);
    if (remaining >= 0) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(refillPerMs / 1000)) };
  } catch {
    if (action === "read" && limits.limiterFailurePolicy === "open-reads") {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    throw new DomainError("DEPENDENCY_UNAVAILABLE", {
      detail: "Rate limiter is unavailable; writes are paused rather than unprotected.",
    });
  }
}

/** Same as `checkLimit`, but throws the documented 429 problem on denial. */
export async function requireLimit(
  store: LimiterStore,
  limits: LimitsConfig,
  action: LimitAction,
  workspaceId: string,
  now?: number,
): Promise<void> {
  const check = await checkLimit(store, limits, action, workspaceId, now);
  if (!check.allowed) {
    throw new DomainError("RATE_LIMITED", {
      detail: `Too many ${action} requests for this workspace.`,
      details: { retryAfterSeconds: check.retryAfterSeconds, action },
    });
  }
}

export function checkUploadBounds(
  limits: LimitsConfig,
  bytes: number,
  rows: number,
): { ok: true } | { ok: false; error: DomainError } {
  if (bytes > limits.uploadMaxBytes) {
    return {
      ok: false,
      error: new DomainError("VALIDATION_FAILED", {
        detail: `File too large: ${bytes} bytes exceeds the ${limits.uploadMaxBytes} byte limit.`,
        errors: [{ field: "file", message: `must be at most ${limits.uploadMaxBytes} bytes` }],
      }),
    };
  }
  if (rows > limits.uploadMaxRows) {
    return {
      ok: false,
      error: new DomainError("VALIDATION_FAILED", {
        detail: `Too many rows: ${rows} exceeds the ${limits.uploadMaxRows} row limit.`,
        errors: [{ field: "rows", message: `must be at most ${limits.uploadMaxRows} rows` }],
      }),
    };
  }
  return { ok: true };
}

/**
 * Per-workspace execution quota with a global ceiling. Slots are acquired
 * BEFORE any command/job row is written, so rejection leaves no partial
 * state. One workspace can never consume another's reserved capacity: the
 * per-workspace cap binds first, the global cap only bounds the total.
 */
export class ExecutionQuota {
  private readonly runningByWorkspace = new Map<string, number>();
  private runningGlobal = 0;

  constructor(private readonly limits: LimitsConfig = loadLimits()) {}

  tryAcquire(workspaceId: string): { acquired: boolean; retryAfterSeconds: number } {
    const running = this.runningByWorkspace.get(workspaceId) ?? 0;
    if (running >= this.limits.maxRunningJobsPerWorkspace) {
      return { acquired: false, retryAfterSeconds: 5 };
    }
    if (this.runningGlobal >= this.limits.maxRunningJobsGlobal) {
      return { acquired: false, retryAfterSeconds: 5 };
    }
    this.runningByWorkspace.set(workspaceId, running + 1);
    this.runningGlobal += 1;
    return { acquired: true, retryAfterSeconds: 0 };
  }

  release(workspaceId: string): void {
    const running = this.runningByWorkspace.get(workspaceId) ?? 0;
    if (running > 0) {
      this.runningByWorkspace.set(workspaceId, running - 1);
      this.runningGlobal -= 1;
    }
  }

  running(workspaceId: string): number {
    return this.runningByWorkspace.get(workspaceId) ?? 0;
  }
}

/** Acquire-then-act: quota rejection throws BEFORE `act` runs (no half-commits). */
export async function withExecutionSlot<T>(
  quota: ExecutionQuota,
  workspaceId: string,
  act: () => Promise<T>,
): Promise<T> {
  const slot = quota.tryAcquire(workspaceId);
  if (!slot.acquired) {
    throw new DomainError("RATE_LIMITED", {
      detail: "Workspace execution quota is full. Retry when a running job finishes.",
      details: { retryAfterSeconds: slot.retryAfterSeconds, action: "job-submit" },
    });
  }
  try {
    return await act();
  } finally {
    quota.release(workspaceId);
  }
}
