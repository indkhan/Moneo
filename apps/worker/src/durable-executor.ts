import { and, eq } from "drizzle-orm";
import { backgroundJobAttempts, backgroundJobs } from "@moneo/db/schema";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import type { Db } from "@moneo/db/client";
import { createRetryDecider } from "./retry.js";
import { runDurableJob, type DurableJob, type JobHandler, type JobStore } from "./job-lifecycle.js";

function asDurableJob(row: typeof backgroundJobs.$inferSelect): DurableJob {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type,
    status: row.status as DurableJob["status"],
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    payload: row.payload,
  };
}

/**
 * Postgres-backed lifecycle store scoped to the workspace carried in the
 * outbox queue payload. The queue never decides status; it only asks this
 * durable store to run a logical job id.
 */
export function createDrizzleJobStore(workspaceId: string): JobStore {
  const transaction = <T>(fn: (db: Db) => Promise<T>) => withWorkspaceTransaction(workspaceId, fn);
  return {
    load: (jobId) =>
      transaction(async (db) => {
        const rows = await db
          .select()
          .from(backgroundJobs)
          .where(and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.workspaceId, workspaceId)))
          .limit(1);
        return rows[0] ? asDurableJob(rows[0]) : null;
      }),
    createAttempt: (jobId, attemptNumber) =>
      transaction(async (db) => {
        await db.insert(backgroundJobAttempts).values({ jobId, workspaceId, attemptNumber });
      }),
    markRunning: (jobId, workerId) =>
      transaction(async (db) => {
        await db
          .update(backgroundJobs)
          .set({
            status: "running",
            lockedBy: workerId,
            lockedAt: new Date(),
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.workspaceId, workspaceId)));
      }),
    heartbeat: (jobId, attemptNumber) =>
      transaction(async (db) => {
        const now = new Date();
        await db
          .update(backgroundJobs)
          .set({ heartbeatAt: now, updatedAt: now })
          .where(and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.workspaceId, workspaceId)));
        await db
          .update(backgroundJobAttempts)
          .set({ heartbeatAt: now })
          .where(
            and(
              eq(backgroundJobAttempts.jobId, jobId),
              eq(backgroundJobAttempts.workspaceId, workspaceId),
              eq(backgroundJobAttempts.attemptNumber, attemptNumber),
            ),
          );
      }),
    finishAttempt: (jobId, attemptNumber, status, error) =>
      transaction(async (db) => {
        await db
          .update(backgroundJobAttempts)
          .set({ status, error, finishedAt: new Date() })
          .where(
            and(
              eq(backgroundJobAttempts.jobId, jobId),
              eq(backgroundJobAttempts.workspaceId, workspaceId),
              eq(backgroundJobAttempts.attemptNumber, attemptNumber),
            ),
          );
      }),
    markSucceeded: (jobId, result) =>
      transaction(async (db) => {
        await db
          .update(backgroundJobs)
          .set({
            status: "succeeded",
            result,
            completedAt: new Date(),
            updatedAt: new Date(),
            lockedBy: null,
          })
          .where(and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.workspaceId, workspaceId)));
      }),
    markRetryable: (jobId, attempts, runAfter, error) =>
      transaction(async (db) => {
        await db
          .update(backgroundJobs)
          .set({
            status: "queued",
            attempts,
            runAfter,
            error,
            updatedAt: new Date(),
            lockedBy: null,
            lockedAt: null,
          })
          .where(and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.workspaceId, workspaceId)));
      }),
    markFailed: (jobId, attempts, error) =>
      transaction(async (db) => {
        await db
          .update(backgroundJobs)
          .set({
            status: "failed",
            attempts,
            error,
            completedAt: new Date(),
            updatedAt: new Date(),
            lockedBy: null,
          })
          .where(and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.workspaceId, workspaceId)));
      }),
    markCancelled: (jobId, attempts) =>
      transaction(async (db) => {
        await db
          .update(backgroundJobs)
          .set({
            status: "cancelled",
            attempts,
            cancelledAt: new Date(),
            completedAt: new Date(),
            updatedAt: new Date(),
            lockedBy: null,
          })
          .where(and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.workspaceId, workspaceId)));
      }),
  };
}

export function createDurableJobExecutor(handlers: ReadonlyMap<string, JobHandler>) {
  return (jobId: string, workspaceId: string, workerId: string) =>
    runDurableJob(
      createDrizzleJobStore(workspaceId),
      handlers,
      createRetryDecider(),
      jobId,
      workerId,
    );
}
