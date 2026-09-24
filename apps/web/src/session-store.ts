// E01-S02 server-checked sessions. Every API read re-checks the row:
// exists, not revoked, not expired. Session ids are 256-bit CSPRNG hex.
// No tokens, codes or secrets are stored or logged here.

import { randomBytes } from "node:crypto";
import type { Pool } from "pg";

export type Session = {
  id: string;
  keycloakSub: string;
  createdAt: string;
  expiresAt: string;
  /** Server-verified step-up instant (Keycloak auth_time claim), or null when no verified step-up was observed. */
  stepUpAt: string | null;
  /** Verified acr claim recorded alongside the step-up, or null. */
  stepUpAcr: string | null;
};

export async function createSession(pool: Pool, keycloakSub: string, ttlSec: number): Promise<Session> {
  const id = randomBytes(32).toString("hex");
  const rows = await pool.query(
    "INSERT INTO app_sessions (id, keycloak_sub, expires_at) VALUES ($1, $2, now() + ($3 || ' seconds')::interval) RETURNING id, keycloak_sub AS \"keycloakSub\", created_at AS \"createdAt\", expires_at AS \"expiresAt\", step_up_at AS \"stepUpAt\", step_up_acr AS \"stepUpAcr\"",
    [id, keycloakSub, String(ttlSec)],
  );
  const session = rows.rows[0] as Session;
  if (session.stepUpAt === undefined) session.stepUpAt = null;
  if (session.stepUpAcr === undefined) session.stepUpAcr = null;
  return session;
}

/**
 * Record a server-verified step-up on a live session. The instant and acr
 * come from the provider's verified claims (never user input); callers must
 * validate them before calling. Idempotent per login: re-recording keeps the
 * latest verified instant.
 */
export async function recordStepUp(pool: Pool, id: string, at: Date, acr: string | null): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(id)) return;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return;
  const cleanAcr = typeof acr === "string" && acr.length >= 1 && acr.length <= 64 ? acr : null;
  await pool.query("UPDATE app_sessions SET step_up_at = $2, step_up_acr = $3 WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()", [
    id,
    at.toISOString(),
    cleanAcr,
  ]);
}

/** Returns the live session or null. Invalid, revoked and expired reads are indistinguishable. */
export async function readSession(pool: Pool, id: string): Promise<Session | null> {
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const rows = await pool.query(
    "SELECT id, keycloak_sub AS \"keycloakSub\", created_at AS \"createdAt\", expires_at AS \"expiresAt\", step_up_at AS \"stepUpAt\", step_up_acr AS \"stepUpAcr\" FROM app_sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()",
    [id],
  );
  const row = (rows.rows[0] as Session | undefined) ?? null;
  if (!row) return null;
  // Pre-041 rows predate the step-up columns on databases migrated before
  // this story; normalize to explicit nulls rather than undefined.
  if (row.stepUpAt === undefined) row.stepUpAt = null;
  if (row.stepUpAcr === undefined) row.stepUpAcr = null;
  return row;
}

/** Idempotent: revoking twice, or revoking an unknown/expired id, still succeeds. */
export async function revokeSession(pool: Pool, id: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(id)) return;
  await pool.query("UPDATE app_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
}

export async function countLiveSessions(pool: Pool): Promise<number> {
  const rows = await pool.query("SELECT count(*)::int AS n FROM app_sessions WHERE revoked_at IS NULL AND expires_at > now()");
  return (rows.rows[0] as { n: number }).n;
}

/** Bounded cleanup of long-expired rows; live and recently-expired rows are kept for reconnect semantics. */
export async function purgeExpired(pool: Pool): Promise<number> {
  const rows = await pool.query("DELETE FROM app_sessions WHERE expires_at < now() - interval '1 day'");
  return rows.rowCount ?? 0;
}
