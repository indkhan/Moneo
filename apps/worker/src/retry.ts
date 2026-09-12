/**
 * Issue 2.7 — classified retry handling.
 *
 * Not every failure deserves another try. Each failure is classified once:
 *
 *   TRANSIENT                — blip (timeout, 503, connection reset): retry with backoff.
 *   PERMANENT_INPUT          — caller data is wrong: retrying is pointless, fail fast.
 *   PERMANENT_POLICY         — forbidden/cancelled by policy: fail fast.
 *   UNKNOWN_EXTERNAL_OUTCOME — third party says "maybe" (the dangerous one):
 *                              retry BOUNDED, and only through idempotent paths.
 *   BUG_INVARIANT            — our own bug (TypeError, assertion): never retry in
 *                              a loop; fail loudly so it pages, not spins.
 *
 * Retries are bounded by `maxAttempts` and spaced by exponential backoff with
 * jitter, so a fleet of workers never retries in lockstep (thundering herd).
 */

export const RETRY_CLASSES = [
  "TRANSIENT",
  "PERMANENT_INPUT",
  "PERMANENT_POLICY",
  "UNKNOWN_EXTERNAL_OUTCOME",
  "BUG_INVARIANT",
] as const;

export type RetryClass = (typeof RETRY_CLASSES)[number];

/** Opt-in marker: handlers throw these (or set `retryClass`) for exact control. */
export class ClassifiedError extends Error {
  readonly retryClass: RetryClass;

  constructor(retryClass: RetryClass, message: string) {
    super(message);
    this.name = "ClassifiedError";
    this.retryClass = retryClass;
  }
}

export const transientError = (message: string): ClassifiedError =>
  new ClassifiedError("TRANSIENT", message);
export const permanentInputError = (message: string): ClassifiedError =>
  new ClassifiedError("PERMANENT_INPUT", message);
export const permanentPolicyError = (message: string): ClassifiedError =>
  new ClassifiedError("PERMANENT_POLICY", message);
export const unknownOutcomeError = (message: string): ClassifiedError =>
  new ClassifiedError("UNKNOWN_EXTERNAL_OUTCOME", message);
export const bugInvariantError = (message: string): ClassifiedError =>
  new ClassifiedError("BUG_INVARIANT", message);

function hasRetryClass(value: unknown): value is { retryClass: RetryClass } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = (value as { retryClass?: unknown }).retryClass;
  return (
    typeof candidate === "string" && (RETRY_CLASSES as readonly string[]).includes(candidate)
  );
}

const TRANSIENT_HINT = /timed? ?out|econn|eai_again|socket hang up|temporar|unavailable|try again|429|50[23]|rate.?limit|overloaded/i;
const INPUT_HINT = /validation|invalid|invariant|bad input|zod|schema|parse/i;
const POLICY_HINT = /forbidden|unauthorized|policy|cancelled|not permitted/i;

/**
 * Best-effort classification for errors that carry no explicit class.
 * Explicit `retryClass` always wins; programmer bugs (TypeError and family)
 * are bugs even when their message mentions a timeout.
 */
export function classifyError(error: unknown): RetryClass {
  if (hasRetryClass(error)) {
    return error.retryClass;
  }
  if (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError
  ) {
    return "BUG_INVARIANT";
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "JobCancelledError" || POLICY_HINT.test(`${name} ${message}`)) {
    return "PERMANENT_POLICY";
  }
  if (name === "CommandError" || name === "DomainError" || name === "ZodError") {
    return /forbidden/i.test(message) ? "PERMANENT_POLICY" : "PERMANENT_INPUT";
  }
  if (INPUT_HINT.test(message)) {
    return "PERMANENT_INPUT";
  }
  if (TRANSIENT_HINT.test(message)) {
    return "TRANSIENT";
  }
  if (error instanceof Error) {
    return "UNKNOWN_EXTERNAL_OUTCOME";
  }
  return "UNKNOWN_EXTERNAL_OUTCOME";
}

/** Retryable classes. Everything else fails the job immediately. */
export function isRetryableClass(retryClass: RetryClass): boolean {
  return retryClass === "TRANSIENT" || retryClass === "UNKNOWN_EXTERNAL_OUTCOME";
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

/**
 * Exponential backoff with equal jitter: `delay/2 + rand * delay/2`, where
 * `delay = min(maxDelay, base * 2^(attempt-1))`. `rand` defaults to Math.random
 * and is injectable for deterministic tests.
 */
export function computeBackoffMs(
  attemptMade: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  rand: () => number = Math.random,
): number {
  const attempt = Math.max(1, Math.floor(attemptMade));
  const capped = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const r = Math.min(Math.max(rand(), 0), 1);
  return Math.floor(capped / 2 + r * (capped / 2));
}

export interface RetryPlan {
  retry: boolean;
  retryClass: RetryClass;
  /** Set when `retry` is true. */
  runAfter?: Date;
}

/**
 * Full decision: classify, check the attempt budget, and schedule backoff.
 * `now` is injectable so tests assert exact `runAfter` timestamps.
 */
export function planRetry(
  error: unknown,
  attemptsMade: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  now: Date = new Date(),
  rand: () => number = Math.random,
): RetryPlan {
  const retryClass = classifyError(error);
  if (!isRetryableClass(retryClass)) {
    return { retry: false, retryClass };
  }
  if (attemptsMade >= policy.maxAttempts) {
    return { retry: false, retryClass };
  }
  return {
    retry: true,
    retryClass,
    runAfter: new Date(now.getTime() + computeBackoffMs(attemptsMade, policy, rand)),
  };
}

/**
 * Drop-in `DecideRetry` for the Issue 2.6 lifecycle: the worker calls this
 * after every handler failure.
 */
export function createRetryDecider(
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  rand: () => number = Math.random,
) {
  return (
    error: unknown,
    attemptsMade: number,
    maxAttempts: number,
  ): { retry: boolean; runAfter?: Date } => {
    const plan = planRetry(
      error,
      attemptsMade,
      { ...policy, maxAttempts },
      new Date(),
      rand,
    );
    return plan.retry ? { retry: true, runAfter: plan.runAfter } : { retry: false };
  };
}
