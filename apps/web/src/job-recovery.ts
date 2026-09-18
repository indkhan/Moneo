// E02-S02 fenced recovery, attempt history and durable cancel (architecture
// ##189, 195, 197, 199-201, 215). Every claim bumps the monotonic
// attempt_generation under a row lock; every checkpoint/final write commits
// only when the generation still matches, the job is RUNNING and
// cancellation has not won. A superseded worker may finish computing but its
// writes update zero rows and its attempt is marked STALE. Heartbeats are
// visibility only (never a competing lock). Cancel is cooperative: the
// durable cancel_requested_at signal wins at the next atomic boundary and
// already-committed effects are never rolled back.

import type { Pool, PoolClient } from "pg";
import type { Queue } from "bullmq";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";
import {
  resolveJobRoute,
  sweepDispatchIndex,
  type JobPayload,
  type JobRoute,
  type JobView,
} from "./jobs.ts";

export const RECONCILE_BATCH_LIMIT = 100;
export const DEFAULT_RUNTIME_LEASE_MS = 30_000;
const LEASE_MS_MIN = 100;
const LEASE_MS_MAX = 600_000;
const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

export type Claim = { attemptId: string; attemptNo: number; generation: number };

export class RecoveryError extends Error {
  readonly code: "not_found" | "terminal" | "cancelled" | "lease_held" | "stale_attempt";
  constructor(code: RecoveryError["code"]) {
    super(code);
    this.code = code;
  }
}

export type FenceResult = { ok: true } | { ok: false; reason: "stale_attempt" | "cancelled" | "terminal" };

export function validateLeaseMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < LEASE_MS_MIN || value > LEASE_MS_MAX) {
    throw new TenantInvalid();
  }
  return value;
}

export function validateWorkerId(value: unknown): string {
  if (typeof value !== "string" || !WORKER_ID_RE.test(value)) throw new TenantInvalid();
  return value;
}

export function parseLeaseMsEnv(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_RUNTIME_LEASE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < LEASE_MS_MIN || parsed > LEASE_MS_MAX) {
    throw new Error(`E02-S02 worker refused: JOB_LEASE_MS must be an integer ${LEASE_MS_MIN}-${LEASE_MS_MAX}.`);
  }
  return parsed;
}

type JobRow = {
  status: string;
  attempt_generation: string;
  cancel_requested_at: string | null;
  lease_expires_at: string | null;
};

async function loadJobForUpdate(client: PoolClient, workspaceId: string, jobId: string): Promise<JobRow | null> {
  const found = await client.query(
    "SELECT status, attempt_generation, cancel_requested_at, lease_expires_at FROM background_jobs WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    [workspaceId, jobId],
  );
  return ((found.rowCount ?? 0) === 0 ? null : (found.rows[0] as JobRow));
}

function leaseLive(leaseExpiresAt: string | null): boolean {
  return leaseExpiresAt !== null && new Date(leaseExpiresAt).getTime() > Date.now();
}

/**
 * Atomically claim a QUEUED job, or reclaim a RUNNING job whose lease
 * expired. Concurrent claimants serialize on the row lock; losers observe a
 * live lease (LEASE_HELD) or converge on the winner's generation. Claiming
 * marks prior RUNNING attempts STALE so history shows the supersede chain.
 * Cancel always wins before claim.
 */
export async function claimAttempt(
  pool: Pool,
  route: JobRoute & { jobId: string },
  workerId: string,
  leaseMs: number,
  bullmqJobId?: string,
): Promise<Claim> {
  const worker = validateWorkerId(workerId);
  const lease = validateLeaseMs(leaseMs);
  if (bullmqJobId !== undefined && (typeof bullmqJobId !== "string" || bullmqJobId.length > 200)) throw new TenantInvalid();
  return withTenant(pool, { userId: route.acceptedBy, workspaceId: route.workspaceId }, async (client) => {
    const job = await loadJobForUpdate(client, route.workspaceId, route.jobId);
    if (!job) {
      await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
      throw new RecoveryError("not_found");
    }
    if (job.cancel_requested_at !== null || job.status === "CANCELLED" || job.status === "CANCEL_REQUESTED") {
      throw new RecoveryError("cancelled");
    }
    if (job.status === "SUCCEEDED" || job.status === "FAILED_FINAL") throw new RecoveryError("terminal");
    if (job.status === "RUNNING" && leaseLive(job.lease_expires_at)) throw new RecoveryError("lease_held");
    if (job.status !== "QUEUED" && job.status !== "RUNNING") throw new RecoveryError("terminal");
    const attemptId = uuidv7();
    const counted = await client.query("SELECT coalesce(max(attempt_no), 0)::int AS n FROM background_job_attempts WHERE workspace_id = $1 AND background_job_id = $2", [
      route.workspaceId,
      route.jobId,
    ]);
    const attemptNo = ((counted.rows[0] as { n: number }).n) + 1;
    const next = await client.query(
      "UPDATE background_jobs SET status = 'RUNNING', attempt_generation = attempt_generation + 1, attempt_count = attempt_count + 1, lease_expires_at = now() + make_interval(secs => $3), started_at = coalesce(started_at, now()), progress_stage = 'claimed', last_heartbeat_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING attempt_generation",
      [route.workspaceId, route.jobId, lease / 1000],
    );
    const generation = Number((next.rows[0] as { attempt_generation: string }).attempt_generation);
    // Supersede chain stays visible: prior live attempts become STALE the
    // moment a replacement generation claims the job.
    await client.query(
      "UPDATE background_job_attempts SET status = 'STALE', completed_at = coalesce(completed_at, now()) WHERE workspace_id = $1 AND background_job_id = $2 AND status = 'RUNNING' AND id <> $3",
      [route.workspaceId, route.jobId, attemptId],
    );
    await client.query(
      "INSERT INTO background_job_attempts (workspace_id, id, background_job_id, attempt_no, generation, worker_instance_id, bullmq_job_id, started_at, heartbeat_at, status) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), 'RUNNING')",
      [route.workspaceId, attemptId, route.jobId, attemptNo, generation, worker, bullmqJobId ?? null],
    );
    return { attemptId, attemptNo, generation };
  });
}

/**
 * Visibility-only heartbeat. Returns false when the attempt is no longer
 * the fenced generation (caller must stop); never extends ownership.
 */
export async function heartbeatAttempt(
  pool: Pool,
  route: JobRoute & { jobId: string },
  attemptId: string,
): Promise<boolean> {
  if (!isUuid(attemptId)) throw new TenantInvalid();
  return withTenant(pool, { userId: route.acceptedBy, workspaceId: route.workspaceId }, async (client) => {
    const attempt = await client.query(
      "SELECT generation, status FROM background_job_attempts WHERE workspace_id = $1 AND id = $2",
      [route.workspaceId, attemptId],
    );
    if ((attempt.rowCount ?? 0) === 0) return false;
    const row = attempt.rows[0] as { generation: string; status: string };
    if (row.status !== "RUNNING") return false;
    const job = await client.query("SELECT status, attempt_generation FROM background_jobs WHERE workspace_id = $1 AND id = $2", [
      route.workspaceId,
      route.jobId,
    ]);
    if ((job.rowCount ?? 0) === 0) return false;
    const current = job.rows[0] as { status: string; attempt_generation: string };
    if (current.status !== "RUNNING" || Number(current.attempt_generation) !== Number(row.generation)) return false;
    await client.query("UPDATE background_job_attempts SET heartbeat_at = now() WHERE workspace_id = $1 AND id = $2", [route.workspaceId, attemptId]);
    await client.query("UPDATE background_jobs SET last_heartbeat_at = now() WHERE workspace_id = $1 AND id = $2", [route.workspaceId, route.jobId]);
    return true;
  });
}

async function fencedGuard(
  client: PoolClient,
  route: JobRoute & { jobId: string },
  claim: Pick<Claim, "attemptId" | "generation">,
): Promise<{ ok: true } | { ok: false; reason: "cancelled" | "terminal" | "stale_attempt" }> {
  // The row lock makes guard -> writes -> COMMIT atomic against concurrent
  // cancel/claim transactions (which take the same lock): exactly one of
  // publish vs cancel/claim wins, never a blend of both.
  const job = await client.query(
    "SELECT status, attempt_generation, cancel_requested_at FROM background_jobs WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    [route.workspaceId, route.jobId],
  );
  if ((job.rowCount ?? 0) === 0) return { ok: false, reason: "terminal" };
  const row = job.rows[0] as { status: string; attempt_generation: string; cancel_requested_at: string | null };
  if (row.cancel_requested_at !== null || row.status === "CANCELLED" || row.status === "CANCEL_REQUESTED") return { ok: false, reason: "cancelled" };
  if (row.status !== "RUNNING" || Number(row.attempt_generation) !== claim.generation) return { ok: false, reason: "stale_attempt" };
  const attempt = await client.query("SELECT status FROM background_job_attempts WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [route.workspaceId, claim.attemptId]);
  if ((attempt.rowCount ?? 0) === 0 || (attempt.rows[0] as { status: string }).status !== "RUNNING") {
    return { ok: false, reason: "stale_attempt" };
  }
  return { ok: true };
}

async function markAttempt(
  client: PoolClient,
  route: JobRoute & { jobId: string },
  attemptId: string,
  status: "SUCCEEDED" | "STALE" | "CANCELLED",
): Promise<void> {
  await client.query("UPDATE background_job_attempts SET status = $3, completed_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'RUNNING'", [
    route.workspaceId,
    attemptId,
    status,
  ]);
  if (status === "CANCELLED") {
    // A cancelled fence finalizes the cooperative cancel so reads converge
    // on CANCELLED immediately after the atomic boundary. Committed effects
    // are untouched — this only closes jobs still awaiting publication.
    await client.query(
      "UPDATE background_jobs SET status = 'CANCELLED', completed_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'CANCEL_REQUESTED'",
      [route.workspaceId, route.jobId],
    );
  }
}

/**
 * Persist one synthetic checkpoint stage. Fails closed (STALE/CANCELLED/
 * terminal) without mutating job state; the attempt row records the fence
 * decision for the visible history.
 */
export async function checkpointAttempt(
  pool: Pool,
  route: JobRoute & { jobId: string },
  claim: Pick<Claim, "attemptId" | "generation">,
  stage: string,
): Promise<FenceResult> {
  if (typeof stage !== "string" || stage.length < 1 || stage.length > 64) throw new TenantInvalid();
  if (!isUuid(claim.attemptId)) throw new TenantInvalid();
  return withTenant(pool, { userId: route.acceptedBy, workspaceId: route.workspaceId }, async (client) => {
    const guard = await fencedGuard(client, route, claim);
    if (!guard.ok) {
      await markAttempt(client, route, claim.attemptId, guard.reason === "cancelled" ? "CANCELLED" : "STALE");
      return guard;
    }
    await client.query("UPDATE background_job_attempts SET checkpoint_stage = $3, heartbeat_at = now() WHERE workspace_id = $1 AND id = $2", [
      route.workspaceId,
      claim.attemptId,
      stage,
    ]);
    await client.query("UPDATE background_jobs SET progress_stage = $3, last_heartbeat_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2", [
      route.workspaceId,
      route.jobId,
      stage,
    ]);
    return { ok: true };
  });
}

/**
 * Fenced terminal publish for the synthetic effect: exactly one immutable
 * result row per job, then SUCCEEDED + attempt history + index retirement in
 * the same transaction. A superseded or cancelled attempt changes only its
 * own attempt row.
 */
export async function commitEffectFenced(
  pool: Pool,
  route: JobRoute & { jobId: string },
  claim: Pick<Claim, "attemptId" | "generation">,
): Promise<FenceResult> {
  if (!isUuid(claim.attemptId)) throw new TenantInvalid();
  return withTenant(pool, { userId: route.acceptedBy, workspaceId: route.workspaceId }, async (client) => {
    const guard = await fencedGuard(client, route, claim);
    if (!guard.ok) {
      await markAttempt(client, route, claim.attemptId, guard.reason === "cancelled" ? "CANCELLED" : "STALE");
      return guard;
    }
    // Defense in depth: the terminal write re-asserts the fence as a
    // predicate (the guard's row lock already serializes us, so a zero-row
    // update here means a logic error, never a silent blend). The claim
    // lands BEFORE the result insert so a lost fence publishes nothing.
    const terminal = await client.query(
      "UPDATE background_jobs SET status = 'SUCCEEDED', completed_at = now(), progress_stage = 'effect', updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'RUNNING' AND attempt_generation = $3 AND cancel_requested_at IS NULL",
      [route.workspaceId, route.jobId, claim.generation],
    );
    if ((terminal.rowCount ?? 0) !== 1) {
      await markAttempt(client, route, claim.attemptId, "STALE");
      return { ok: false, reason: "stale_attempt" };
    }
    await client.query(
      "INSERT INTO background_job_results (workspace_id, id, background_job_id, result_kind) VALUES ($1, $2, $3, 'synthetic-noop') ON CONFLICT (workspace_id, background_job_id) DO NOTHING",
      [route.workspaceId, uuidv7(), route.jobId],
    );
    const result = await client.query("SELECT id FROM background_job_results WHERE workspace_id = $1 AND background_job_id = $2", [
      route.workspaceId,
      route.jobId,
    ]);
    await client.query("UPDATE background_jobs SET result_ref = $3 WHERE workspace_id = $1 AND id = $2", [
      route.workspaceId,
      route.jobId,
      JSON.stringify({ backgroundJobResultId: (result.rows[0] as { id: string }).id }),
    ]);
    await markAttempt(client, route, claim.attemptId, "SUCCEEDED");
    await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
    return { ok: true };
  });
}

export type CancelResult = { status: JobView["status"]; changed: boolean; effectApplied: boolean };

/**
 * Durable cooperative cancel. QUEUED wins immediately (CANCELLED, transport
 * consumed, index retired); RUNNING records CANCEL_REQUESTED for the worker
 * to observe at its next fence; terminal states and repeat cancels are
 * idempotent no-ops reporting current state. Committed effects are never
 * undone — effectApplied reports what finished first.
 */
export async function cancelJob(pool: Pool, claims: TenantClaims, jobId: string): Promise<CancelResult | null> {
  if (!isUuid(jobId)) return null;
  return withTenant(pool, claims, async (client) => {
    const found = await client.query(
      "SELECT status FROM background_jobs WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
      [claims.workspaceId, jobId],
    );
    if ((found.rowCount ?? 0) === 0) return null;
    const status = (found.rows[0] as { status: string }).status as JobView["status"];
    const effect = await client.query("SELECT 1 FROM background_job_results WHERE workspace_id = $1 AND background_job_id = $2", [
      claims.workspaceId,
      jobId,
    ]);
    const effectApplied = (effect.rowCount ?? 0) === 1;
    if (status === "SUCCEEDED" || status === "FAILED_FINAL" || status === "CANCELLED") {
      return { status, changed: false, effectApplied };
    }
    if (status === "QUEUED") {
      await client.query(
        "UPDATE background_jobs SET status = 'CANCELLED', cancel_requested_at = coalesce(cancel_requested_at, now()), completed_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2",
        [claims.workspaceId, jobId],
      );
      await client.query("UPDATE outbox_events SET published_at = now() WHERE workspace_id = $1 AND aggregate_id = $2 AND published_at IS NULL", [
        claims.workspaceId,
        jobId,
      ]);
      await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [claims.workspaceId, jobId]);
      await client.query(
        "UPDATE background_job_attempts SET status = 'CANCELLED', completed_at = now() WHERE workspace_id = $1 AND background_job_id = $2 AND status = 'RUNNING'",
        [claims.workspaceId, jobId],
      );
      return { status: "CANCELLED", changed: true, effectApplied };
    }
    // RUNNING or CANCEL_REQUESTED: record the request; the worker's next
    // fence observes it and publishes nothing further.
    await client.query(
      "UPDATE background_jobs SET status = 'CANCEL_REQUESTED', cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now() WHERE workspace_id = $1 AND id = $2",
      [claims.workspaceId, jobId],
    );
    return { status: "CANCEL_REQUESTED", changed: status !== "CANCEL_REQUESTED", effectApplied };
  });
}

export type ProcessOutcome = "applied" | "duplicate-terminal-noop";

/**
 * Phased synthetic handler: claim (fenced generation) -> two checkpoints ->
 * fenced publish. Crash between phases leaves PG truth resumable: the next
 * delivery reclaims with a new generation and the attempt history shows the
 * supersede chain. Exactly one immutable effect per job.
 */
export async function processImportJobPhased(
  pool: Pool,
  backgroundJobId: string,
  opts?: { workerId?: string; leaseMs?: number; bullmqJobId?: string },
): Promise<ProcessOutcome> {
  if (!isUuid(backgroundJobId)) throw new TenantInvalid();
  const route = await resolveJobRoute(pool, backgroundJobId);
  if (!route) return "duplicate-terminal-noop";
  const full = { ...route, jobId: backgroundJobId };
  const workerId = opts?.workerId ?? `jobs-worker-${process.pid}`;
  const leaseMs = opts?.leaseMs ?? DEFAULT_RUNTIME_LEASE_MS;
  let claim: Claim;
  try {
    claim = await claimAttempt(pool, full, workerId, leaseMs, opts?.bullmqJobId);
  } catch (err) {
    if (err instanceof RecoveryError && (err.code === "not_found" || err.code === "terminal" || err.code === "cancelled")) {
      return "duplicate-terminal-noop";
    }
    // lease_held intentionally propagates (typed RecoveryError): another
    // live attempt owns the job, so this delivery must back off rather than
    // report completion. The IO worker maps it to a deferred outcome;
    // direct callers treat it as retry-later, never as success.
    throw err;
  }
  const pick = { attemptId: claim.attemptId, generation: claim.generation };
  const first = await checkpointAttempt(pool, full, pick, "checkpoint-a");
  if (!first.ok) return "duplicate-terminal-noop";
  const second = await checkpointAttempt(pool, full, pick, "checkpoint-b");
  if (!second.ok) return "duplicate-terminal-noop";
  const published = await commitEffectFenced(pool, full, pick);
  return published.ok ? "applied" : "duplicate-terminal-noop";
}

/**
 * Missing-transport reconciler: replays the dispatch sweep over the ID-only
 * index with a reconciler-sized batch. Rebuilds eligible nonterminal work
 * after worker death or total Redis loss; never re-enqueues terminal or
 * cancelled work (consumed instead); tenant-B rows are untouched by
 * construction (per-route membership). Batch capped at 100 per the story
 * limit; the sweep shares the dispatch fence (deterministic keys +
 * idempotent handler), so running it twice converges.
 */
export async function reconcileTransport(
  pool: Pool,
  queue: Queue<JobPayload>,
  limit = RECONCILE_BATCH_LIMIT,
): Promise<{ enqueued: number; skipped: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > RECONCILE_BATCH_LIMIT) throw new Error("reconcile limit out of range");
  return sweepDispatchIndex(pool, queue, limit);
}

export function jobDenied(err: unknown): boolean {
  return err instanceof TenantDenied;
}
