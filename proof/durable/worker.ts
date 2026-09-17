// E00-S04 fenced execution (architecture sections 189, 195, 197, 199).
// A claim atomically raises the monotonic attempt generation under a row lock;
// publication commits only when the generation still matches, the job is
// RUNNING and cancellation has not won. A superseded worker may finish its
// computation but its publish updates zero rows and is recorded STALE.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ProofError } from "./commands.ts";

export type Claim = {
  attemptId: string;
  attemptNo: number;
  generation: number;
};

export type PublishResult =
  | { ok: true }
  | { ok: false; reason: "STALE_ATTEMPT" | "CANCELLED" | "TERMINAL" };

/**
 * Atomically claim a QUEUED job, or reclaim a RUNNING job whose PG lease
 * expired. Concurrent claimants serialize on the row lock; losers observe the
 * live lease and receive LEASE_HELD instead of double-executing.
 */
export async function claimAttempt(
  pool: Pool,
  tenantId: string,
  operationId: string,
  workerId: string,
  leaseMs: number,
): Promise<Claim> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT state, attempt_generation, cancel_requested_at, lease_expires_at FROM proof_jobs WHERE operation_id = $1 AND tenant_id = $2 FOR UPDATE",
      [operationId, tenantId],
    );
    if (cur.rowCount !== 1) throw new ProofError("NOT_FOUND", "unknown operation for tenant");
    const row = cur.rows[0];
    if (row.cancel_requested_at !== null || row.state === "CANCELLED") {
      throw new ProofError("CANCELLED", "job is cancelled");
    }
    if (row.state === "SUCCEEDED") throw new ProofError("TERMINAL", "job already succeeded");
    if (row.state === "RUNNING" && row.lease_expires_at !== null && new Date(row.lease_expires_at) > new Date()) {
      throw new ProofError("LEASE_HELD", "a live attempt holds the lease");
    }
    if (row.state !== "QUEUED" && row.state !== "RUNNING") {
      throw new ProofError("TERMINAL", `job is ${row.state as string}`);
    }
    const attemptId = randomUUID();
    const no = await client.query("SELECT count(*)::int AS n FROM proof_attempts WHERE operation_id = $1", [
      operationId,
    ]);
    const attemptNo = (no.rows[0].n as number) + 1;
    const next = await client.query(
      `UPDATE proof_jobs SET state = 'RUNNING',
        attempt_generation = attempt_generation + 1,
        claimed_attempt_id = $3, lease_expires_at = now() + make_interval(secs => $4),
        updated_at = now()
       WHERE operation_id = $1 AND tenant_id = $2
       RETURNING attempt_generation`,
      [operationId, tenantId, attemptId, leaseMs / 1000],
    );
    const generation = Number(next.rows[0].attempt_generation as string | number);
    await client.query(
      "INSERT INTO proof_attempts (id, operation_id, tenant_id, attempt_no, generation, worker_id, status) VALUES ($1, $2, $3, $4, $5, $6, 'RUNNING')",
      [attemptId, operationId, tenantId, attemptNo, generation, workerId],
    );
    await client.query("COMMIT");
    return { attemptId, attemptNo, generation };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore; connection returns to the pool either way.
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Publish the synthetic effect exactly once. The compare-and-swap on
 * (RUNNING, generation, no-cancel) plus the PK on proof_effects give two
 * independent backstops against stale or duplicate publication.
 */
export async function publishEffect(
  pool: Pool,
  tenantId: string,
  operationId: string,
  claim: Pick<Claim, "attemptId" | "generation">,
): Promise<PublishResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const swapped = await client.query(
      `UPDATE proof_jobs SET state = 'SUCCEEDED', lease_expires_at = NULL, updated_at = now()
       WHERE operation_id = $1 AND tenant_id = $2 AND state = 'RUNNING'
         AND attempt_generation = $3 AND cancel_requested_at IS NULL`,
      [operationId, tenantId, claim.generation],
    );
    if (swapped.rowCount !== 1) {
      const cur = await client.query(
        "SELECT state, attempt_generation, cancel_requested_at FROM proof_jobs WHERE operation_id = $1 AND tenant_id = $2",
        [operationId, tenantId],
      );
      const row = cur.rows[0] as
        | { state: string; cancel_requested_at: string | null }
        | undefined;
      // Unknown (or foreign-tenant) operation: answer STALE_ATTEMPT without
      // disclosing whether the operation exists, and touch nothing.
      if (row === undefined) {
        await client.query("COMMIT");
        return { ok: false, reason: "STALE_ATTEMPT" };
      }
      const cancelled = row.cancel_requested_at !== null || row.state === "CANCELLED";
      // Never overwrite a terminal attempt record: a duplicate publish of an
      // already-succeeded claim reports TERMINAL and leaves history intact.
      await client.query(
        "UPDATE proof_attempts SET status = $2, completed_at = now() WHERE id = $1 AND status = 'RUNNING'",
        [claim.attemptId, cancelled ? "BLOCKED" : "STALE"],
      );
      await client.query("COMMIT");
      return { ok: false, reason: cancelled ? "CANCELLED" : row.state === "SUCCEEDED" ? "TERMINAL" : "STALE_ATTEMPT" };
    }
    const counter = await client.query("SELECT payload FROM proof_commands WHERE operation_id = $1", [
      operationId,
    ]);
    const counterId = (counter.rows[0].payload as { counterId: string }).counterId;
    await client.query(
      "INSERT INTO proof_effects (operation_id, tenant_id, counter_id) VALUES ($1, $2, $3)",
      [operationId, tenantId, counterId],
    );
    await client.query(
      "UPDATE proof_counters SET value = value + 1 WHERE tenant_id = $1 AND counter_id = $2",
      [tenantId, counterId],
    );
    await client.query(
      "UPDATE proof_attempts SET status = 'SUCCEEDED', completed_at = now() WHERE id = $1",
      [claim.attemptId],
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore; connection returns to the pool either way.
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * The real-queue processor: claim, then publish. Duplicate transport delivery
 * of an already-succeeded job exits as a no-op without touching effects.
 */
export async function processApplyJob(
  pool: Pool,
  tenantId: string,
  operationId: string,
  workerId: string,
  leaseMs: number,
): Promise<string> {
  let claim: Claim;
  try {
    claim = await claimAttempt(pool, tenantId, operationId, workerId, leaseMs);
  } catch (e) {
    if (e instanceof ProofError && (e.code === "TERMINAL" || e.code === "CANCELLED")) {
      return e.code === "TERMINAL" ? "duplicate-terminal-noop" : "cancelled-noop";
    }
    if (e instanceof ProofError && e.code === "LEASE_HELD") return "lease-held-retry-later";
    throw e;
  }
  const published = await publishEffect(pool, tenantId, operationId, claim);
  return published.ok ? "applied" : `not-published-${published.reason.toLowerCase().replace(/_/g, "-")}`;
}
