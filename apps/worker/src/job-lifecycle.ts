/**
 * Issue 2.6 — generic durable job execution lifecycle.
 *
 * One BullMQ delivery runs exactly this sequence:
 *
 *   load durable job -> check cancellation/terminal state -> create attempt ->
 *   mark running -> heartbeat -> execute -> mark success/final failure/cancelled
 *
 * The database row (Issue 2.4) is truth; the queue delivery is just a hint.
 * That is what makes double delivery safe: the second delivery reloads the
 * row, sees a terminal state, and does nothing (proven in the tests).
 *
 * Retry *policy* is injected (`decideRetry`, implemented in Issue 2.7): this
 * file only records the outcome the policy chooses.
 */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type AttemptStatus = "started" | "succeeded" | "failed";

export interface DurableJob {
  id: string;
  workspaceId: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
}

export interface JobAttempt {
  jobId: string;
  attemptNumber: number;
  status: AttemptStatus;
  error: Record<string, unknown> | null;
}

export interface JobStore {
  load(jobId: string): Promise<DurableJob | null>;
  createAttempt(jobId: string, attemptNumber: number): Promise<void>;
  markRunning(jobId: string, workerId: string, attemptNumber: number): Promise<void>;
  heartbeat(jobId: string, attemptNumber: number): Promise<void>;
  finishAttempt(
    jobId: string,
    attemptNumber: number,
    status: AttemptStatus,
    error: Record<string, unknown> | null,
  ): Promise<void>;
  markSucceeded(jobId: string, result: Record<string, unknown>): Promise<void>;
  /** Requeue after a retryable failure; eligible again at `runAfter`. */
  markRetryable(
    jobId: string,
    attempts: number,
    runAfter: Date,
    error: Record<string, unknown>,
  ): Promise<void>;
  markFailed(jobId: string, attempts: number, error: Record<string, unknown>): Promise<void>;
  markCancelled(jobId: string, attempts: number): Promise<void>;
}

export interface HandlerContext {
  jobId: string;
  workspaceId: string;
  attemptNumber: number;
  workerId: string;
  heartbeat(): Promise<void>;
  isCancelled(): Promise<boolean>;
}

export type JobHandler = (
  payload: Record<string, unknown>,
  ctx: HandlerContext,
) => Promise<Record<string, unknown>>;

/** Thrown by a handler to request cooperative cancellation. */
export class JobCancelledError extends Error {
  constructor(message = "job cancelled") {
    super(message);
    this.name = "JobCancelledError";
  }
}

export interface RetryDecision {
  retry: boolean;
  /** Eligible-again time when `retry` is true. */
  runAfter?: Date;
}

export type DecideRetry = (
  error: unknown,
  attemptsMade: number,
  maxAttempts: number,
) => RetryDecision;

export type RunOutcome =
  | { status: "succeeded"; attemptNumber: number }
  | { status: "failed"; attemptNumber: number; retried: boolean }
  | { status: "cancelled"; attemptNumber: number | null }
  | {
      status: "skipped";
      reason: "not-found" | "terminal" | "cancelled-before-start";
      attemptNumber: null;
    };

const TERMINAL: readonly JobStatus[] = ["succeeded", "failed", "cancelled"];

function errorRecord(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: `unknown failure: ${typeof error}` };
}

export async function runDurableJob(
  store: JobStore,
  handlers: ReadonlyMap<string, JobHandler>,
  decideRetry: DecideRetry,
  jobId: string,
  workerId: string,
): Promise<RunOutcome> {
  // Step 1 — load durable job (the row is truth, the delivery is a hint).
  const job = await store.load(jobId);
  if (!job) {
    return { status: "skipped", reason: "not-found", attemptNumber: null };
  }

  // Step 2 — check cancellation/terminal state BEFORE creating an attempt, so
  // duplicate deliveries of finished work leave no trace.
  if (job.status === "cancelled") {
    return { status: "skipped", reason: "cancelled-before-start", attemptNumber: null };
  }
  if (TERMINAL.includes(job.status)) {
    return { status: "skipped", reason: "terminal", attemptNumber: null };
  }

  const attemptNumber = job.attempts + 1;

  // Steps 3 + 4 — create attempt, mark running.
  await store.createAttempt(jobId, attemptNumber);
  await store.markRunning(jobId, workerId, attemptNumber);

  const ctx: HandlerContext = {
    jobId,
    workspaceId: job.workspaceId,
    attemptNumber,
    workerId,
    heartbeat: () => store.heartbeat(jobId, attemptNumber),
    isCancelled: () => store.load(jobId).then((current) => current?.status === "cancelled"),
  };

  // Steps 5 + 6 — heartbeat + execute.
  try {
    const handler = handlers.get(job.type);
    if (!handler) {
      throw new Error(`no handler registered for job type "${job.type}"`);
    }
    const result = await handler(job.payload, ctx);

    // Step 7a — mark success.
    await store.finishAttempt(jobId, attemptNumber, "succeeded", null);
    await store.markSucceeded(jobId, result);
    return { status: "succeeded", attemptNumber };
  } catch (error) {
    if (error instanceof JobCancelledError || (await ctx.isCancelled())) {
      // Step 7c — cancelled (cooperative throw or a Stop arriving mid-run).
      await store.finishAttempt(jobId, attemptNumber, "failed", errorRecord(error));
      await store.markCancelled(jobId, attemptNumber);
      return { status: "cancelled", attemptNumber };
    }
    // Step 7b — failure: policy decides retry vs final.
    const record = errorRecord(error);
    await store.finishAttempt(jobId, attemptNumber, "failed", record);
    const decision = decideRetry(error, attemptNumber, job.maxAttempts);
    if (decision.retry) {
      await store.markRetryable(jobId, attemptNumber, decision.runAfter ?? new Date(), record);
      return { status: "failed", attemptNumber, retried: true };
    }
    await store.markFailed(jobId, attemptNumber, record);
    return { status: "failed", attemptNumber, retried: false };
  }
}
