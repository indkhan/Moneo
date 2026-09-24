// E02-S05: import commit with multiplicity-safe duplicate review.
// Deterministic chunk commit; stable source keys; explicit match/new/pending/rejected
// decisions; resolution commands; exact batch summary and completion outbox.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";
import {
  claimAttempt,
  DEFAULT_RUNTIME_LEASE_MS,
  fencedGuard,
  markAttempt,
  RecoveryError,
  validateLeaseMs,
  validateWorkerId,
  type Claim,
} from "./job-recovery.ts";
import { resolveJobRoute, IMPORTS_COMMIT, IMPORTS_JOB_VERSION, type JobRoute } from "./jobs.ts";
import { maybeTriggerDeepAnalysisTx } from "./deep-analysis.ts";

export type ImportCommitConfig = {
  commitChunkRows: number;
  matchWindowDays: number;
  batchIdleTimeoutMs: number;
};

export const DEFAULT_COMMIT_CONFIG: ImportCommitConfig = {
  commitChunkRows: 500,
  matchWindowDays: 3,
  batchIdleTimeoutMs: 5 * 60 * 1000,
};

export class ImportCommitError extends Error {
  readonly code: "not_found" | "idempotency_reuse" | "idempotency_expired" | "invalid_import_state" | "workspace_busy";
  readonly currentStatus?: string;
  constructor(code: ImportCommitError["code"], currentStatus?: string) {
    super(code);
    this.code = code;
    this.currentStatus = currentStatus;
  }
}

export type AcceptCommitInput = { workspaceId: string; idempotencyKey: string; importId: string; accountId: string };

export type CommitJobView = {
  workspaceId: string;
  id: string;
  jobType: string;
  jobVersion: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED_FINAL" | "CANCEL_REQUESTED" | "CANCELLED";
  attemptCount: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type AcceptCommitResult = { view: CommitJobView; operationId: string; jobId: string; replayed: boolean };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateAcceptCommitInput(value: unknown): AcceptCommitInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "idempotencyKey", "importId", "accountId"].includes(key)) throw new TenantInvalid();
  }
  const { workspaceId, idempotencyKey, importId, accountId } = v;
  if (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) throw new TenantInvalid();
  if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) throw new TenantInvalid();
  if (typeof importId !== "string" || !UUID_RE.test(importId)) throw new TenantInvalid();
  if (typeof accountId !== "string" || !UUID_RE.test(accountId)) throw new TenantInvalid();
  return { workspaceId, idempotencyKey, importId, accountId };
}

function acceptCommitRequestHash(input: AcceptCommitInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ jobType: IMPORTS_COMMIT, importId: input.importId, accountId: input.accountId, workspaceId: input.workspaceId }))
    .digest("hex");
}

function rowToCommitView(row: {
  workspace_id: string;
  id: string;
  job_type: string;
  job_version: string;
  status: CommitJobView["status"];
  attempt_count: string;
  queued_at: unknown;
  started_at: unknown;
  completed_at: unknown;
}): CommitJobView {
  const iso = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    jobType: row.job_type,
    jobVersion: row.job_version,
    status: row.status,
    attemptCount: String(row.attempt_count),
    queuedAt: iso(row.queued_at) ?? String(row.queued_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  };
}

type StoredCommitOp = {
  operationId: string;
  status: string;
  requestHash: string;
  response: unknown;
  error: { code: ImportCommitError["code"] } | null;
  expiresAt: string;
};

async function readCommitJobByDedup(client: PoolClient, workspaceId: string, dedup: string): Promise<CommitJobView | null> {
  const found = await client.query(
    "SELECT workspace_id, id, job_type, job_version, status, attempt_count, queued_at, started_at, completed_at FROM background_jobs WHERE workspace_id = $1 AND deduplication_key = $2",
    [workspaceId, dedup],
  );
  if ((found.rowCount ?? 0) === 0) return null;
  return rowToCommitView(found.rows[0] as Parameters<typeof rowToCommitView>[0]);
}

async function acceptCommitTx(client: PoolClient, claims: TenantClaims, actorId: string, input: AcceptCommitInput): Promise<{ ok: true; result: AcceptCommitResult } | { ok: false; code: ImportCommitError["code"]; currentStatus?: string }> {
  const hash = acceptCommitRequestHash(input);
  const dedup = `${IMPORTS_COMMIT}:${input.idempotencyKey}`;

  const readOp = async (): Promise<StoredCommitOp | undefined> => {
    const found = await client.query(
      "SELECT id AS \"operationId\", status, request_hash AS \"requestHash\", response_payload AS \"response\", error_payload AS \"error\", expires_at AS \"expiresAt\" FROM command_operations WHERE workspace_id = $1 AND command_name = $2 AND idempotency_key = $3",
      [claims.workspaceId, IMPORTS_COMMIT, input.idempotencyKey],
    );
    return found.rows[0] as StoredCommitOp | undefined;
  };

  const settle = async (row: StoredCommitOp): Promise<{ ok: true; result: AcceptCommitResult } | { ok: false; code: ImportCommitError["code"]; currentStatus?: string }> => {
    if (new Date(row.expiresAt).getTime() <= Date.now()) return { ok: false, code: "idempotency_expired" };
    if (row.requestHash !== hash) return { ok: false, code: "idempotency_reuse" };
    if (row.status === "SUCCEEDED") {
      const resumed = row.response as { jobId: string } | null;
      const job = resumed ? await readCommitJobByDedup(client, claims.workspaceId, dedup) : null;
      if (!job) return { ok: false, code: "not_found" };
      return { ok: true, result: { view: job, operationId: row.operationId, jobId: job.id, replayed: true } };
    }
    return { ok: false, code: row.error?.code ?? "idempotency_reuse" };
  };

  const prior = await readOp();
  if (prior) return settle(prior);

  for (let attempt = 0; attempt < 3; attempt++) {
    const operationId = uuidv7();
    await client.query("SAVEPOINT import_commit_claim");
    let claimed = false;
    try {
      await client.query(
        "INSERT INTO command_operations (workspace_id, id, command_name, idempotency_key, request_hash, actor_id, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'FAILED_FINAL', now() + ($7 || ' days')::interval)",
        [claims.workspaceId, operationId, IMPORTS_COMMIT, input.idempotencyKey, hash, actorId, String(30)],
      );
      claimed = true;
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      await client.query("ROLLBACK TO SAVEPOINT import_commit_claim");
    }
    if (!claimed) {
      let row: StoredCommitOp | undefined;
      for (let poll = 0; poll < 20; poll++) {
        row = await readOp();
        if (row) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (row) return settle(row);
      continue;
    }

    const fail = async (code: ImportCommitError["code"]): Promise<{ ok: false; code: ImportCommitError["code"] }> => {
      await client.query("UPDATE command_operations SET status = 'FAILED_FINAL', error_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
        JSON.stringify({ code }),
        claims.workspaceId,
        operationId,
      ]);
      return { ok: false, code };
    };

    // Fairness cap: at most 2 active synthetic import jobs/workspace (includes parse + commit)
    const active = await client.query(
      "SELECT count(*)::int AS n FROM background_jobs WHERE workspace_id = $1 AND status IN ('QUEUED', 'RUNNING')",
      [claims.workspaceId],
    );
    if ((active.rows[0] as { n: number }).n >= 2) return fail("workspace_busy");

    // Verify import is STAGED and belongs to workspace
    const importCheck = await client.query("SELECT status FROM imports WHERE workspace_id = $1 AND id = $2", [
      claims.workspaceId,
      input.importId,
    ]);
    if ((importCheck.rowCount ?? 0) === 0 || (importCheck.rows[0] as { status: string }).status !== "STAGED") {
      return fail("invalid_import_state");
    }

    const jobId = uuidv7();
    const outboxId = uuidv7();
    const inputRef = JSON.stringify({ importId: input.importId, accountId: input.accountId });
    await client.query(
      "INSERT INTO background_jobs (workspace_id, id, job_type, job_version, status, deduplication_key, command_operation_id, input_ref) VALUES ($1, $2, 'imports.commit', '1', 'QUEUED', $3, $4, $5)",
      [claims.workspaceId, jobId, dedup, operationId, inputRef],
    );
    const payload = JSON.stringify({ backgroundJobId: jobId });
    if (Buffer.byteLength(payload, "utf8") > 1024) throw new Error("job payload exceeds 1 KiB");
    await client.query(
      "INSERT INTO outbox_events (workspace_id, id, event_type, aggregate_type, aggregate_id, payload) VALUES ($1, $2, 'job.ready', 'background_job', $3, $4)",
      [claims.workspaceId, outboxId, jobId, payload],
    );
    await client.query("INSERT INTO job_dispatch_index (workspace_id, job_id, outbox_id, accepted_by) VALUES ($1, $2, $3, $4)", [
      claims.workspaceId,
      jobId,
      outboxId,
      actorId,
    ]);
    const view = await readCommitJobByDedup(client, claims.workspaceId, dedup);
    if (!view) throw new Error("job row missing after accept");
    await client.query("UPDATE command_operations SET status = 'SUCCEEDED', response_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
      JSON.stringify({ jobId }),
      claims.workspaceId,
      operationId,
    ]);
    return { ok: true, result: { view, operationId, jobId, replayed: false } };
  }
  throw new Error("command_claim_unsettled");
}

export async function acceptImportCommitJob(
  pool: Pool,
  claims: TenantClaims,
  actorId: string,
  raw: unknown,
): Promise<AcceptCommitResult> {
  const input = validateAcceptCommitInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (!isUuid(actorId)) throw new TenantDenied();
  // The input needs importId to find the parse job. Let's extend the input.
  const outcome = await withTenant(pool, claims, (client) => acceptCommitTx(client, claims, actorId, input));
  if (!outcome.ok) throw new ImportCommitError(outcome.code, outcome.currentStatus);
  return outcome.result;
}

export async function readImportCommitStatus(
  pool: Pool,
  claims: TenantClaims,
  importId: string,
): Promise<{ jobId: string; status: string; counts: { total: number; staged: number; matched: number; review: number; rejected: number } } | null> {
  if (!isUuid(importId)) return null;
  return withTenant(pool, claims, async (client) => {
    const importRow = await client.query("SELECT id FROM imports WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, importId]);
    if ((importRow.rowCount ?? 0) === 0) return null;
    const job = await client.query(
      "SELECT id, status, result_ref FROM background_jobs WHERE workspace_id = $1 AND deduplication_key = $2 ORDER BY created_at DESC LIMIT 1",
      [claims.workspaceId, `imports.commit:${importId}`],
    );
    if ((job.rowCount ?? 0) === 0) return null;
    const jobRow = job.rows[0] as { id: string; status: string; result_ref: { total: number; staged: number; matched: number; review: number; rejected: number } | null };
    return { jobId: jobRow.id, status: jobRow.status, counts: jobRow.result_ref ?? { total: 0, staged: 0, matched: 0, review: 0, rejected: 0 } };
  });
}

export type StagedObservation = {
  importId: string;
  rowNo: number;
  observationId: string;
  amountMinor: string;
  currency: string;
  direction: "INFLOW" | "OUTFLOW";
  effectiveDate: string;
  description: string;
  sourceSheet: string | null;
};

export type MatchCandidate = {
  transactionId: string;
  amountMinor: string;
  currency: string;
  direction: "INFLOW" | "OUTFLOW";
  effectiveDate: string;
  description: string;
};

export type CommitCounts = {
  total: number;
  staged: number;
  matched: number;
  review: number;
  rejected: number;
};

type Route = JobRoute & { jobId: string };

async function terminalFail(
  client: PoolClient,
  route: Route,
  claim: Pick<Claim, "attemptId" | "generation">,
  importId: string,
  errorCode: string,
): Promise<void> {
  await client.query("UPDATE background_jobs SET status = 'FAILED_FINAL', completed_at = now(), error_payload = $3, progress_stage = 'failed', updated_at = now() WHERE workspace_id = $1 AND id = $2", [
    route.workspaceId,
    route.jobId,
    JSON.stringify({ importId, failed: errorCode }),
  ]);
  await markAttempt(client, route, claim.attemptId, "STALE");
  await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
}

function parseDateOrNull(value: string): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return isNaN(d.getTime()) ? null : d;
}

function generateSourceKey(workspaceId: string, importId: string, rowNo: number, observationId: string): string {
  const hash = createHash("sha256").update(`${workspaceId}:${importId}:${rowNo}:${observationId}`).digest("hex").slice(0, 32);
  return `src:${hash}`;
}

function isExactMatch(staged: StagedObservation, existing: MatchCandidate, windowDays: number): boolean {
  if (staged.amountMinor !== existing.amountMinor) return false;
  if (staged.currency !== existing.currency) return false;
  if (staged.direction !== existing.direction) return false;
  if (staged.description.trim() !== existing.description.trim()) return false;
  const stagedDate = parseDateOrNull(staged.effectiveDate);
  const existingDate = parseDateOrNull(existing.effectiveDate);
  if (!stagedDate || !existingDate) return false;
  const diffMs = Math.abs(stagedDate.getTime() - existingDate.getTime());
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  return diffMs <= windowMs;
}

async function findMatchCandidates(
  client: PoolClient,
  workspaceId: string,
  staged: StagedObservation,
  windowDays: number,
): Promise<MatchCandidate[]> {
  const startDate = new Date(parseDateOrNull(staged.effectiveDate)!.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const endDate = new Date(parseDateOrNull(staged.effectiveDate)!.getTime() + windowDays * 24 * 60 * 60 * 1000);
  const res = await client.query(
    `SELECT t.id AS "transactionId", t.amount_minor AS "amountMinor", t.currency, t.direction, t.effective_date::text AS "effectiveDate", t.description
     FROM transactions t
     WHERE t.workspace_id = $1
       AND t.amount_minor = $2
       AND t.currency = $3
       AND t.direction = $4
       AND t.description = $5
       AND t.effective_date BETWEEN $6 AND $7
       AND t.import_id <> $8
       AND NOT EXISTS (
         SELECT 1 FROM source_links sl
         WHERE sl.workspace_id = t.workspace_id AND sl.import_id = $8
           AND sl.target_transaction_id = t.id AND sl.status = 'MATCHED'
       )
     ORDER BY t.effective_date, t.id`,
    [workspaceId, staged.amountMinor, staged.currency, staged.direction, staged.description, startDate, endDate, staged.importId],
  );
  return res.rows as MatchCandidate[];
}

async function createSourceLink(
  client: PoolClient,
  workspaceId: string,
  importId: string,
  rowNo: number,
  observationId: string,
  status: "NEW" | "MATCHED" | "PENDING_REVIEW" | "REJECTED" | "KEPT_DISTINCT",
  targetTransactionId: string | null = null,
  matchReason: string | null = null,
): Promise<string> {
  const sourceLinkId = uuidv7();
  await client.query(
    `INSERT INTO source_links (workspace_id, id, import_id, import_row_no, observation_id, target_transaction_id, status, match_reason, resolved_at, resolved_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (workspace_id, import_id, import_row_no) DO UPDATE SET
       status = EXCLUDED.status,
       target_transaction_id = EXCLUDED.target_transaction_id,
       match_reason = EXCLUDED.match_reason,
       resolved_at = EXCLUDED.resolved_at,
       resolved_by = EXCLUDED.resolved_by`,
    [workspaceId, sourceLinkId, importId, rowNo, observationId, targetTransactionId, status, matchReason, status !== "NEW" ? new Date() : null, null],
  );
  return sourceLinkId;
}

async function processCommitChunk(
  client: PoolClient,
  workspaceId: string,
  accountId: string,
  stagedRows: StagedObservation[],
  config: ImportCommitConfig,
): Promise<CommitCounts> {
  let total = 0;
  let staged = 0;
  let matched = 0;
  let review = 0;
  let rejected = 0;

  for (const obs of stagedRows) {
    total++;
    const prior = await client.query(
      "SELECT status FROM source_links WHERE workspace_id = $1 AND import_id = $2 AND import_row_no = $3",
      [workspaceId, obs.importId, obs.rowNo],
    );
    if ((prior.rowCount ?? 0) > 0) {
      const status = (prior.rows[0] as { status: string }).status;
      if (status === "NEW" || status === "KEPT_DISTINCT") staged++;
      else if (status === "MATCHED") matched++;
      else if (status === "PENDING_REVIEW") review++;
      else rejected++;
      continue;
    }
    const candidates = await findMatchCandidates(client, workspaceId, obs, config.matchWindowDays);
    const exactMatch = candidates.find((c) => isExactMatch(obs, c, config.matchWindowDays));

    if (exactMatch) {
      // Exact match found: link to existing transaction
      await createSourceLink(client, workspaceId, obs.importId, obs.rowNo, obs.observationId, "MATCHED", exactMatch.transactionId, "exact-match");
      matched++;
    } else if (candidates.length > 0) {
      // Near matches exist but not exact: pending review
      await createSourceLink(client, workspaceId, obs.importId, obs.rowNo, obs.observationId, "PENDING_REVIEW");
      review++;
    } else {
      // No candidates: create new transaction
      const txId = uuidv7();
      const effDate = parseDateOrNull(obs.effectiveDate);
      if (!effDate) {
        // Invalid date should not reach here (parser validates), but defend
        await createSourceLink(client, workspaceId, obs.importId, obs.rowNo, obs.observationId, "REJECTED", null, "invalid-date");
        rejected++;
        continue;
      }
      const inserted = await client.query(
        `INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (workspace_id, import_id, import_row_no) DO NOTHING
         RETURNING id`,
        [workspaceId, txId, accountId, obs.amountMinor, obs.currency, obs.direction, effDate, obs.description, obs.importId, obs.rowNo, obs.observationId],
      );
      const transactionId = (inserted.rows[0] as { id: string } | undefined)?.id ?? (await client.query(
        "SELECT id FROM transactions WHERE workspace_id = $1 AND import_id = $2 AND import_row_no = $3",
        [workspaceId, obs.importId, obs.rowNo],
      )).rows[0]?.id;
      if (!transactionId) throw new Error("committed transaction missing");
      await createSourceLink(client, workspaceId, obs.importId, obs.rowNo, obs.observationId, "NEW", transactionId);
      staged++;
    }
  }
  return { total, staged, matched, review, rejected };
}

export async function processCommitJob(
  pool: Pool,
  backgroundJobId: string,
  config: ImportCommitConfig,
  opts?: { workerId?: string; leaseMs?: number; bullmqJobId?: string; faultAfterChunk?: number },
): Promise<"applied" | "deferred-transient" | "duplicate-terminal-noop"> {
  if (!isUuid(backgroundJobId)) throw new TenantInvalid();
  const workerId = validateWorkerId(opts?.workerId ?? `jobs-worker-${process.pid}`);
  const leaseMs = validateLeaseMs(opts?.leaseMs ?? DEFAULT_RUNTIME_LEASE_MS);
  const baseRoute = await resolveJobRoute(pool, backgroundJobId);
  if (!baseRoute) return "duplicate-terminal-noop";
  const route: Route = { ...baseRoute, jobId: backgroundJobId };
  let claim: Claim;
  try {
    claim = await claimAttempt(pool, route, workerId, leaseMs, opts?.bullmqJobId);
  } catch (err) {
    if (err instanceof RecoveryError && (err.code === "not_found" || err.code === "terminal" || err.code === "cancelled")) {
      return "duplicate-terminal-noop";
    }
    throw err;
  }
  const pick = { attemptId: claim.attemptId, generation: claim.generation };
  const fenced = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T | { fencedOut: true; reason: string }> => {
    return withTenant(pool, { userId: route.acceptedBy, workspaceId: route.workspaceId }, async (client) => {
      const guard = await fencedGuard(client, route, pick);
      if (!guard.ok) {
        await markAttempt(client, route, pick.attemptId, guard.reason === "cancelled" ? "CANCELLED" : "STALE");
        return { fencedOut: true as const, reason: guard.reason };
      }
      return work(client);
    });
  };
  const fencedOut = (value: unknown): value is { fencedOut: true; reason: string } => {
    return typeof value === "object" && value !== null && "fencedOut" in value;
  };

  // Load job input (importId + accountId from mapping profile)
  const loaded = await fenced(async (client) => {
    const job = await client.query("SELECT input_ref FROM background_jobs WHERE workspace_id = $1 AND id = $2", [route.workspaceId, route.jobId]);
    if ((job.rowCount ?? 0) === 0) return null;
    const inputRef = job.rows[0] as { input_ref: { importId: string; accountId: string } };
    const importRow = await client.query("SELECT status FROM imports WHERE workspace_id = $1 AND id = $2", [route.workspaceId, inputRef.input_ref.importId]);
    if ((importRow.rowCount ?? 0) === 0 || (importRow.rows[0] as { status: string }).status !== "STAGED") return null;
    return { importId: inputRef.input_ref.importId, accountId: inputRef.input_ref.accountId };
  });
  if (fencedOut(loaded) || !loaded) return "duplicate-terminal-noop";

  // Update progress to committing
  await fenced(async (client) => {
    await client.query("UPDATE background_jobs SET progress_stage = 'committing', last_heartbeat_at = now() WHERE workspace_id = $1 AND id = $2", [
      route.workspaceId,
      route.jobId,
    ]);
  });
  if (fencedOut(await fenced(async () => true))) return "duplicate-terminal-noop";

  // Fetch STAGED observations for this import
  const observations = await fenced(async (client) => {
    const res = await client.query(
      `SELECT import_id AS "importId", row_no AS "rowNo", observation_id AS "observationId", amount_minor AS "amountMinor", currency, direction, effective_date::text AS "effectiveDate", description, source_sheet AS "sourceSheet"
       FROM parsed_observations
       WHERE workspace_id = $1 AND import_id = $2 AND status = 'STAGED'
       ORDER BY row_no`,
      [route.workspaceId, loaded.importId],
    );
    return res.rows as StagedObservation[];
  });
  if (fencedOut(observations)) return "duplicate-terminal-noop";

  // Process in deterministic chunks
  let totalCounts: CommitCounts = { total: 0, staged: 0, matched: 0, review: 0, rejected: 0 };
  for (let at = 0; at < observations.length; at += config.commitChunkRows) {
    const chunk = observations.slice(at, at + config.commitChunkRows);
    const counts = await fenced(async (client) => processCommitChunk(client, route.workspaceId, loaded.accountId, chunk, config));
    if (fencedOut(counts)) return "duplicate-terminal-noop";
    totalCounts.total += counts.total;
    totalCounts.staged += counts.staged;
    totalCounts.matched += counts.matched;
    totalCounts.review += counts.review;
    totalCounts.rejected += counts.rejected;
    if (opts?.faultAfterChunk === at / config.commitChunkRows + 1) throw new Error("fault injected after committed chunk");
  }

  // Terminal: finalize job, update import counts, emit completion outbox
  const done = await withTenant(pool, { userId: route.acceptedBy, workspaceId: route.workspaceId }, async (client) => {
    const guard = await fencedGuard(client, route, pick);
    if (!guard.ok) {
      await markAttempt(client, route, pick.attemptId, guard.reason === "cancelled" ? "CANCELLED" : "STALE");
      return guard;
    }
    // Update import with final counts
    await client.query(
      `UPDATE imports SET staged_count = $3, review_count = $4, rejected_count = $5 WHERE workspace_id = $1 AND id = $2`,
      [route.workspaceId, loaded.importId, totalCounts.staged, totalCounts.review, totalCounts.rejected],
    );
    const terminal = await client.query(
      `UPDATE background_jobs SET status = 'SUCCEEDED', completed_at = now(), result_ref = $3, progress_stage = 'effect', updated_at = now()
       WHERE workspace_id = $1 AND id = $2 AND status = 'RUNNING' AND attempt_generation = $4 AND cancel_requested_at IS NULL`,
      [
        route.workspaceId,
        route.jobId,
        JSON.stringify({ importId: loaded.importId, ...totalCounts }),
        pick.generation,
      ],
    );
    if ((terminal.rowCount ?? 0) !== 1) {
      await markAttempt(client, route, pick.attemptId, "STALE");
      return { ok: false as const, reason: "stale_attempt" as const };
    }
    await client.query(
      `INSERT INTO background_job_results (workspace_id, id, background_job_id, result_kind) VALUES ($1, $2, $3, 'import-committed')
       ON CONFLICT (workspace_id, background_job_id) DO NOTHING`,
      [route.workspaceId, uuidv7(), route.jobId],
    );
    // E07-S01: one durable accepted-commit signal in the SAME transaction as
    // commit success. The workspace-keyed claim converges duplicates and the
    // batch window, so redelivered completions emit no second analysis.
    await maybeTriggerDeepAnalysisTx(client, route.workspaceId, route.acceptedBy, loaded.importId);
    await markAttempt(client, route, pick.attemptId, "SUCCEEDED");
    await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
    return { ok: true as const };
  });
  return done.ok ? "applied" : "duplicate-terminal-noop";
}
