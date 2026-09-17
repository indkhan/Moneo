// E00-S04 outbox relay and PG-truth reconciler (architecture sections 186-187,
// 195, 200). The dispatcher closes the dual-write gap between PostgreSQL and
// Redis; the reconciler rebuilds missing transport state from PostgreSQL
// alone and never treats queue job status as the source of truth.

import type { Queue } from "bullmq";
import type { Pool } from "pg";
import { jobKey, type ApplyJobData } from "./queue.ts";

export type DispatchCounts = { enqueued: number; skippedCancelled: number };

/**
 * Relay due outbox events to BullMQ. Crash-safe in both directions: dying
 * before enqueue leaves the event unpublished for the next pass; dying after
 * enqueue but before marking published only causes a deterministic re-enqueue
 * (same job key), which the idempotent handler absorbs.
 */
export async function dispatchOutbox(
  pool: Pool,
  queue: Queue<ApplyJobData>,
  limit = 100,
): Promise<DispatchCounts> {
  const claimed = await pool.query(
    `SELECT id, operation_id, tenant_id FROM proof_outbox
     WHERE published_at IS NULL AND available_at <= now()
     ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  let enqueued = 0;
  let skippedCancelled = 0;
  for (const row of claimed.rows) {
    const operationId = row.operation_id as string;
    const tenantId = row.tenant_id as string;
    const job = await pool.query(
      "SELECT state FROM proof_jobs WHERE operation_id = $1 AND tenant_id = $2",
      [operationId, tenantId],
    );
    if (job.rowCount !== 1 || job.rows[0].state === "CANCELLED") {
      // Cancelled work is consumed without ever touching the transport.
      await pool.query("UPDATE proof_outbox SET published_at = now() WHERE id = $1", [row.id]);
      skippedCancelled += 1;
      continue;
    }
    await enqueueApply(queue, tenantId, operationId);
    await pool.query("UPDATE proof_outbox SET published_at = now() WHERE id = $1", [row.id]);
    enqueued += 1;
  }
  return { enqueued, skippedCancelled };
}

/** Enqueue one apply job; an existing transport record dedups by job key. */
export async function enqueueApply(
  queue: Queue<ApplyJobData>,
  tenantId: string,
  operationId: string,
): Promise<void> {
  const key = jobKey(operationId);
  // Fast path avoids depending on duplicate-add semantics; the catch below
  // covers a concurrent dispatcher winning the race after our check.
  const existing = await queue.getJob(key);
  if (existing) return;
  try {
    await queue.add("apply", { operationId, tenantId }, { jobId: key });
  } catch (e) {
    // A live duplicate transport record is the expected outcome of a prior
    // crash between enqueue and outbox marking; PG remains the truth.
    if ((e as { name?: string }).name === "JobExistsError") return;
    throw e;
  }
}

export type ReconcileCounts = {
  dispatched: number;
  requeuedUnstarted: number;
  requeuedStalled: number;
};

/**
 * Restore missing work after worker death or complete transport loss.
 * Sources of truth, in order: unpublished outbox events, published-but-never-
 * started jobs, RUNNING jobs whose PG lease expired. Queue state is never
 * consulted; re-enqueue is idempotent via deterministic job keys plus the
 * idempotent claim/publish fence.
 */
export async function reconcile(
  pool: Pool,
  queue: Queue<ApplyJobData>,
  limit = 500,
): Promise<ReconcileCounts> {
  const dispatched = await dispatchOutbox(pool, queue, limit);

  const unstarted = await pool.query(
    `SELECT j.operation_id, j.tenant_id FROM proof_jobs j
     JOIN proof_outbox o ON o.operation_id = j.operation_id
     WHERE j.state = 'QUEUED' AND o.published_at IS NOT NULL
     ORDER BY j.operation_id LIMIT $1`,
    [limit],
  );
  let requeuedUnstarted = 0;
  for (const row of unstarted.rows) {
    await enqueueApply(queue, row.tenant_id as string, row.operation_id as string);
    requeuedUnstarted += 1;
  }

  const stalled = await pool.query(
    `SELECT operation_id, tenant_id FROM proof_jobs
     WHERE state = 'RUNNING' AND (lease_expires_at IS NULL OR lease_expires_at <= now())
     ORDER BY operation_id LIMIT $1`,
    [limit],
  );
  let requeuedStalled = 0;
  for (const row of stalled.rows) {
    await enqueueApply(queue, row.tenant_id as string, row.operation_id as string);
    requeuedStalled += 1;
  }
  return {
    dispatched: dispatched.enqueued,
    requeuedUnstarted,
    requeuedStalled,
  };
}
