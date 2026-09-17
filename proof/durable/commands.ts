// E00-S04 idempotent command acceptance. One operation identity maps to at
// most one durable effect; incompatible payload reuse is rejected, never
// merged. Concurrent identical submissions converge via the PK plus a
// re-read on unique violation.

import { createHash } from "node:crypto";
import type { Pool } from "pg";

export type CommandPayload = { counterId: string };

export class ProofError extends Error {
  constructor(
    public readonly code:
      | "INVALID_PAYLOAD"
      | "TENANT_MISMATCH"
      | "INCOMPATIBLE_REUSE"
      | "NOT_FOUND"
      | "TERMINAL"
      | "CANCELLED"
      | "LEASE_HELD"
      | "STALE_ATTEMPT",
    message: string,
  ) {
    super(message);
  }
}

export function canonicalHash(payload: CommandPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function checkPayload(payload: CommandPayload): void {
  if (!payload || typeof payload.counterId !== "string" || !/^[a-z0-9-]{1,40}$/.test(payload.counterId)) {
    throw new ProofError("INVALID_PAYLOAD", "payload.counterId must match [a-z0-9-]{1,40}");
  }
}

export type AcceptedCommand = {
  operationId: string;
  tenantId: string;
  duplicate: boolean;
};

/** Durably accept a synthetic increment command. Idempotent on exact retry. */
export async function acceptCommand(
  pool: Pool,
  tenantId: string,
  operationId: string,
  payload: CommandPayload,
): Promise<AcceptedCommand> {
  checkPayload(payload);
  const hash = canonicalHash(payload);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      "SELECT tenant_id, payload_hash, status FROM proof_commands WHERE operation_id = $1",
      [operationId],
    );
    if (existing.rowCount === 1) {
      const row = existing.rows[0];
      if (row.tenant_id !== tenantId) {
        throw new ProofError("TENANT_MISMATCH", "operation identity belongs to another tenant");
      }
      if (row.payload_hash !== hash) {
        throw new ProofError(
          "INCOMPATIBLE_REUSE",
          "operation identity reused with an incompatible payload",
        );
      }
      await client.query("COMMIT");
      return { operationId, tenantId, duplicate: true };
    }
    try {
      await client.query(
        "INSERT INTO proof_commands (operation_id, tenant_id, payload, payload_hash) VALUES ($1, $2, $3, $4)",
        [operationId, tenantId, JSON.stringify(payload), hash],
      );
      // UNIQUE(operation_id) on the outbox keeps redelivery of the same
      // command from ever queuing a second logical job.
      await client.query(
        "INSERT INTO proof_outbox (operation_id, tenant_id) VALUES ($1, $2) ON CONFLICT (operation_id) DO NOTHING",
        [operationId, tenantId],
      );
      await client.query(
        "INSERT INTO proof_jobs (operation_id, tenant_id) VALUES ($1, $2) ON CONFLICT (operation_id) DO NOTHING",
        [operationId, tenantId],
      );
      await client.query(
        "INSERT INTO proof_counters (tenant_id, counter_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [tenantId, payload.counterId],
      );
      await client.query("COMMIT");
      return { operationId, tenantId, duplicate: false };
    } catch (e) {
      // A concurrent identical submission won the race: converge by re-read.
      if ((e as { code?: string }).code === "23505") {
        await client.query("ROLLBACK");
        return acceptCommand(pool, tenantId, operationId, payload);
      }
      throw e;
    }
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Already rolled back on the 23505 path; safe to ignore.
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Durable cancel. Wins from QUEUED/RUNNING; already-committed effects are not
 * rolled back (reported via effectApplied). Later publication is blocked by
 * the publish fence checking cancel_requested_at.
 */
export async function cancelCommand(
  pool: Pool,
  tenantId: string,
  operationId: string,
): Promise<{ cancelled: boolean; effectApplied: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cmd = await client.query(
      "SELECT status FROM proof_commands WHERE operation_id = $1 AND tenant_id = $2",
      [operationId, tenantId],
    );
    if (cmd.rowCount !== 1) throw new ProofError("NOT_FOUND", "unknown operation for tenant");
    await client.query(
      "UPDATE proof_commands SET status = 'CANCELLED', updated_at = now() WHERE operation_id = $1 AND status = 'ACCEPTED'",
      [operationId],
    );
    await client.query(
      `UPDATE proof_jobs SET cancel_requested_at = now(), updated_at = now(),
        state = CASE WHEN state IN ('QUEUED', 'RUNNING') THEN 'CANCELLED' ELSE state END
       WHERE operation_id = $1 AND tenant_id = $2`,
      [operationId, tenantId],
    );
    const effect = await client.query("SELECT 1 FROM proof_effects WHERE operation_id = $1", [
      operationId,
    ]);
    await client.query("COMMIT");
    // Publish is atomic (effect row + SUCCEEDED in one transaction), so an
    // effect row means the effect committed before cancellation won.
    return { cancelled: true, effectApplied: effect.rowCount === 1 };
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

export async function counterValue(pool: Pool, tenantId: string, counterId: string): Promise<number> {
  const r = await pool.query("SELECT value::int AS v FROM proof_counters WHERE tenant_id = $1 AND counter_id = $2", [
    tenantId,
    counterId,
  ]);
  return r.rowCount === 1 ? (r.rows[0].v as number) : 0;
}
