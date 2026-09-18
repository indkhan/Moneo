// E02-S01 durable jobs + outbox dispatch (architecture ##60-62, 67-69,
// 176-189, 215). PostgreSQL is durable truth; BullMQ is at-least-once
// transport. Accept writes command_operations + background_jobs +
// outbox_events + job_dispatch_index in ONE tenant transaction before the
// dispatcher ever enqueues. The queue payload carries ONLY {backgroundJobId}
// (<=1 KiB). FORCE RLS forbids unscoped reads, so system-side dispatch and
// worker routing resolve (workspace, accepting member) through the ID-only
// job_dispatch_index (no payload/finance/secrets — see 005_jobs.sql) and
// then re-enter withTenant: membership is enforced at every HTTP, worker and
// reconciliation boundary and ordinary workers get no general bypass. The
// synthetic handler inserts exactly one immutable background_job_results row
// per job; duplicate delivery exits without a second effect. No AI permits
// are created or consumed here.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Queue, Worker, type Processor } from "bullmq";
import { Redis } from "ioredis";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";

export const IMPORTS_START = "imports.start";
export const IMPORTS_JOB_VERSION = "1";
const REPLAY_RETENTION_DAYS = 30;
export const MAX_ACTIVE_SYNTHETIC_JOBS = 2;
export const DISPATCH_BATCH_LIMIT = 50;
export const JOBS_QUEUE_NAME = "background";
export const JOBS_QUEUE_PREFIX = "moneo:jobs";
export const OUTBOX_EVENT_READY = "job.ready";

/** Synthetic slice marker: distinguishes canonical intents sharing one key.
 * S03 replaces this with real file/source params; the hash rule stays. */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

export type AcceptInput = { workspaceId: string; idempotencyKey: string; label?: string };

export type JobView = {
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

export type AcceptResult = { view: JobView; operationId: string; jobId: string; replayed: boolean };

export class JobError extends Error {
  readonly code: "not_found" | "idempotency_reuse" | "idempotency_expired" | "workspace_busy";
  readonly currentStatus?: string;
  constructor(code: JobError["code"], currentStatus?: string) {
    super(code);
    this.code = code;
    this.currentStatus = currentStatus;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateAcceptInput(value: unknown): AcceptInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "idempotencyKey", "label"].includes(key)) throw new TenantInvalid();
  }
  const { workspaceId, idempotencyKey, label } = v;
  if (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) throw new TenantInvalid();
  if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) throw new TenantInvalid();
  if (label !== undefined && (typeof label !== "string" || !LABEL_RE.test(label))) throw new TenantInvalid();
  return { workspaceId, idempotencyKey, label: typeof label === "string" ? label : "synthetic" };
}

export function acceptRequestHash(input: AcceptInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ jobType: IMPORTS_START, label: input.label ?? "synthetic", workspaceId: input.workspaceId }))
    .digest("hex");
}

function rowToView(row: {
  workspace_id: string;
  id: string;
  job_type: string;
  job_version: string;
  status: JobView["status"];
  attempt_count: string;
  queued_at: unknown;
  started_at: unknown;
  completed_at: unknown;
}): JobView {
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

type StoredOp = {
  operationId: string;
  status: string;
  requestHash: string;
  response: unknown;
  error: { code: JobError["code"] } | null;
  expiresAt: string;
};

type TxOutcome = { ok: true; result: AcceptResult } | { ok: false; code: JobError["code"]; currentStatus?: string };

async function readJobByDedup(client: PoolClient, workspaceId: string, dedup: string): Promise<JobView | null> {
  const found = await client.query(
    "SELECT workspace_id, id, job_type, job_version, status, attempt_count, queued_at, started_at, completed_at FROM background_jobs WHERE workspace_id = $1 AND deduplication_key = $2",
    [workspaceId, dedup],
  );
  if ((found.rowCount ?? 0) === 0) return null;
  return rowToView(found.rows[0] as Parameters<typeof rowToView>[0]);
}

async function acceptTx(client: PoolClient, claims: TenantClaims, actorId: string, input: AcceptInput): Promise<TxOutcome> {
  const hash = acceptRequestHash(input);
  const dedup = `${IMPORTS_START}:${input.idempotencyKey}`;

  const readOp = async (): Promise<StoredOp | undefined> => {
    const found = await client.query(
      "SELECT id AS \"operationId\", status, request_hash AS \"requestHash\", response_payload AS \"response\", error_payload AS \"error\", expires_at AS \"expiresAt\" FROM command_operations WHERE workspace_id = $1 AND command_name = $2 AND idempotency_key = $3",
      [claims.workspaceId, IMPORTS_START, input.idempotencyKey],
    );
    return found.rows[0] as StoredOp | undefined;
  };

  const settle = async (row: StoredOp): Promise<TxOutcome> => {
    if (new Date(row.expiresAt).getTime() <= Date.now()) return { ok: false, code: "idempotency_expired" };
    if (row.requestHash !== hash) return { ok: false, code: "idempotency_reuse" };
    if (row.status === "SUCCEEDED") {
      const resumed = row.response as { jobId: string } | null;
      const job = resumed ? await readJobByDedup(client, claims.workspaceId, dedup) : null;
      if (!job) return { ok: false, code: "not_found" };
      return { ok: true, result: { view: job, operationId: row.operationId, jobId: job.id, replayed: true } };
    }
    return { ok: false, code: row.error?.code ?? "idempotency_reuse" };
  };

  const prior = await readOp();
  if (prior) return settle(prior);

  for (let attempt = 0; attempt < 3; attempt++) {
    const operationId = uuidv7();
    await client.query("SAVEPOINT imports_claim");
    let claimed = false;
    try {
      await client.query(
        "INSERT INTO command_operations (workspace_id, id, command_name, idempotency_key, request_hash, actor_id, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'FAILED_FINAL', now() + ($7 || ' days')::interval)",
        [claims.workspaceId, operationId, IMPORTS_START, input.idempotencyKey, hash, actorId, String(REPLAY_RETENTION_DAYS)],
      );
      claimed = true;
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      await client.query("ROLLBACK TO SAVEPOINT imports_claim");
    }
    if (!claimed) {
      let row: StoredOp | undefined;
      for (let poll = 0; poll < 20; poll++) {
        row = await readOp();
        if (row) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (row) return settle(row);
      continue;
    }

    const fail = async (code: JobError["code"]): Promise<TxOutcome> => {
      await client.query("UPDATE command_operations SET status = 'FAILED_FINAL', error_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
        JSON.stringify({ code }),
        claims.workspaceId,
        operationId,
      ]);
      return { ok: false, code };
    };

    // Slice fairness cap: at most 2 active synthetic import jobs/workspace.
    const active = await client.query(
      "SELECT count(*)::int AS n FROM background_jobs WHERE workspace_id = $1 AND status IN ('QUEUED', 'RUNNING')",
      [claims.workspaceId],
    );
    if ((active.rows[0] as { n: number }).n >= MAX_ACTIVE_SYNTHETIC_JOBS) return fail("workspace_busy");

    const jobId = uuidv7();
    const outboxId = uuidv7();
    const inputRef = JSON.stringify({ source: "synthetic", label: input.label ?? "synthetic" });
    await client.query(
      "INSERT INTO background_jobs (workspace_id, id, job_type, job_version, status, deduplication_key, command_operation_id, input_ref) VALUES ($1, $2, 'imports.start', '1', 'QUEUED', $3, $4, $5)",
      [claims.workspaceId, jobId, dedup, operationId, inputRef],
    );
    // Minimal transport reference only: never finance rows, tokens or bytes.
    const payload = JSON.stringify({ backgroundJobId: jobId });
    if (Buffer.byteLength(payload, "utf8") > 1024) throw new Error("job payload exceeds 1 KiB");
    await client.query(
      "INSERT INTO outbox_events (workspace_id, id, event_type, aggregate_type, aggregate_id, payload) VALUES ($1, $2, 'job.ready', 'background_job', $3, $4)",
      [claims.workspaceId, outboxId, jobId, payload],
    );
    // Narrow dispatch route (UUIDs only): lets the system-side dispatcher
    // and worker resolve this job without any unscoped tenant-table read.
    // The accepting member is recorded so every later step re-enters
    // withTenant with membership enforced.
    await client.query("INSERT INTO job_dispatch_index (workspace_id, job_id, outbox_id, accepted_by) VALUES ($1, $2, $3, $4)", [
      claims.workspaceId,
      jobId,
      outboxId,
      actorId,
    ]);
    const view = await readJobByDedup(client, claims.workspaceId, dedup);
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

export async function acceptImportJob(
  pool: Pool,
  claims: TenantClaims,
  actorId: string,
  raw: unknown,
): Promise<AcceptResult> {
  const input = validateAcceptInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (!isUuid(actorId)) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => acceptTx(client, claims, actorId, input));
  if (!outcome.ok) throw new JobError(outcome.code, outcome.currentStatus);
  return outcome.result;
}

export async function readJob(pool: Pool, claims: TenantClaims, jobId: string): Promise<JobView | null> {
  if (!isUuid(jobId)) return null;
  return withTenant(pool, claims, async (client) => {
    const found = await client.query(
      "SELECT workspace_id, id, job_type, job_version, status, attempt_count, queued_at, started_at, completed_at FROM background_jobs WHERE workspace_id = $1 AND id = $2",
      [claims.workspaceId, jobId],
    );
    if ((found.rowCount ?? 0) === 0) return null;
    return rowToView(found.rows[0] as Parameters<typeof rowToView>[0]);
  });
}

export type JobRoute = { workspaceId: string; acceptedBy: string; outboxId: string };

/**
 * Narrow discovery: job id -> (workspace id, accepting member, outbox id).
 * Reads ONLY the ID-only dispatch index — no tenant table is touched, so no
 * RLS context is needed and no finance/policy data can leak. Every domain
 * step afterwards re-enters withTenant with the recorded member.
 */
export async function resolveJobRoute(pool: Pool, jobId: string): Promise<JobRoute | null> {
  if (!isUuid(jobId)) return null;
  const found = await pool.query('SELECT workspace_id AS "workspaceId", accepted_by AS "acceptedBy", outbox_id AS "outboxId" FROM job_dispatch_index WHERE job_id = $1', [
    jobId,
  ]);
  if ((found.rowCount ?? 0) === 0) return null;
  const route = found.rows[0] as JobRoute;
  if (!isUuid(route.workspaceId) || !isUuid(route.acceptedBy) || !isUuid(route.outboxId)) return null;
  return route;
}

/** Dispatcher discovery: job id -> workspace id only. Backed by the index. */
export async function discoverJobWorkspace(pool: Pool, jobId: string): Promise<string | null> {
  const route = await resolveJobRoute(pool, jobId);
  return route ? route.workspaceId : null;
}

// ---- BullMQ transport (at-least-once; PG stays the truth) ----

export type JobPayload = { backgroundJobId: string };

export function outboxJobKey(outboxId: string): string {
  return `outbox-${outboxId}`;
}

function redisFromUrl(redisUrl: string, db?: number): Redis {
  const u = new URL(redisUrl);
  let urlDb: number | undefined;
  const pathDb = (u.pathname ?? "").replace(/^\//, "");
  if (/^\d+$/.test(pathDb)) urlDb = Number(pathDb);
  return new Redis({
    host: u.hostname,
    port: Number(u.port || "6379"),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    ...(db === undefined ? (urlDb === undefined ? {} : { db: urlDb }) : { db }),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: 8000,
  });
}

export function jobsQueue(redisUrl: string): Queue<JobPayload> {
  return new Queue<JobPayload>(JOBS_QUEUE_NAME, {
    connection: redisFromUrl(redisUrl),
    prefix: JOBS_QUEUE_PREFIX,
    defaultJobOptions: { attempts: 1, removeOnComplete: { age: 60 }, removeOnFail: { age: 300 } },
  });
}

export function startJobsWorker(redisUrl: string, processor: Processor<JobPayload, string>, concurrency = 2): Worker<JobPayload, string> {
  const worker = new Worker<JobPayload, string>(JOBS_QUEUE_NAME, processor, {
    connection: redisFromUrl(redisUrl),
    prefix: JOBS_QUEUE_PREFIX,
    concurrency,
  });
  worker.on("error", () => undefined);
  return worker;
}

export type DispatchCounts = { enqueued: number; skipped: number };

async function enqueueReady(queue: Queue<JobPayload>, outboxId: string, payload: JobPayload): Promise<void> {
  const raw = JSON.stringify(payload);
  if (Buffer.byteLength(raw, "utf8") > 1024) throw new Error("job payload exceeds 1 KiB");
  if (Object.keys(payload).length !== 1 || typeof payload.backgroundJobId !== "string" || !isUuid(payload.backgroundJobId)) {
    throw new Error("job payload must carry only backgroundJobId");
  }
  const key = outboxJobKey(outboxId);
  const existing = await queue.getJob(key);
  if (existing) return;
  try {
    await queue.add("imports.start", payload, { jobId: key });
  } catch (err) {
    if ((err as { name?: string }).name === "JobExistsError") return;
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Relay due outbox rows to BullMQ. Discovery reads the ID-only dispatch
 * index (no tenant data); every per-job step re-enters withTenant with the
 * recorded accepting member, so membership + FORCE RLS still gate all domain
 * state. Crash-safe both ways: dying before enqueue leaves the row
 * unpublished for the next pass; dying after enqueue but before marking
 * published re-enqueues deterministically (same outbox-<id> key), absorbed
 * by the idempotent handler. Enqueue acknowledgement always precedes
 * published_at. Terminal jobs are consumed (outbox marked, index removed)
 * without ever touching the transport, so the sweep doubles as the S01
 * reconciler after worker death or total Redis loss. Transient transport
 * errors retry at most 3 times with exponential backoff+jitter; permanent
 * input failures are consumed without enqueue.
 */
export async function dispatchOutbox(pool: Pool, queue: Queue<JobPayload>, limit = DISPATCH_BATCH_LIMIT): Promise<DispatchCounts> {
  if (!Number.isInteger(limit) || limit < 1 || limit > DISPATCH_BATCH_LIMIT) throw new Error("dispatch limit out of range");
  const due = await pool.query('SELECT workspace_id AS "workspaceId", job_id AS "jobId", outbox_id AS "outboxId", accepted_by AS "acceptedBy" FROM job_dispatch_index ORDER BY created_at LIMIT $1', [
    limit,
  ]);
  let enqueued = 0;
  let skipped = 0;
  for (const route of due.rows as (JobRoute & { jobId: string })[]) {
    if (!isUuid(route.workspaceId) || !isUuid(route.jobId) || !isUuid(route.acceptedBy) || !isUuid(route.outboxId)) {
      continue;
    }
    const claims: TenantClaims = { userId: route.acceptedBy, workspaceId: route.workspaceId };
    let outcome: "enqueued" | "skipped";
    try {
      outcome = await withTenant(pool, claims, async (client) => {
        const outbox = await client.query("SELECT payload, published_at AS \"publishedAt\" FROM outbox_events WHERE workspace_id = $1 AND id = $2", [
          route.workspaceId,
          route.outboxId,
        ]);
        if ((outbox.rowCount ?? 0) === 0) {
          await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
          return "skipped" as const;
        }
        const job = await client.query("SELECT status FROM background_jobs WHERE workspace_id = $1 AND id = $2", [route.workspaceId, route.jobId]);
        if ((job.rowCount ?? 0) === 0) {
          await client.query("UPDATE outbox_events SET published_at = now() WHERE workspace_id = $1 AND id = $2", [route.workspaceId, route.outboxId]);
          await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
          return "skipped" as const;
        }
        const status = (job.rows[0] as { status: string }).status;
        if (status !== "QUEUED") {
          // Terminal/cancelled/running work is consumed, never re-enqueued
          // as new logical work; the index row retires with the job.
          await client.query("UPDATE outbox_events SET published_at = now() WHERE workspace_id = $1 AND id = $2 AND published_at IS NULL", [
            route.workspaceId,
            route.outboxId,
          ]);
          await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
          return "skipped" as const;
        }
        const payload = (outbox.rows[0] as { payload: JobPayload }).payload as JobPayload;
        if (!payload || typeof payload.backgroundJobId !== "string" || payload.backgroundJobId !== route.jobId) {
          await client.query("UPDATE outbox_events SET published_at = now(), attempt_count = attempt_count + 1, last_error = 'permanent_invalid_payload' WHERE workspace_id = $1 AND id = $2", [
            route.workspaceId,
            route.outboxId,
          ]);
          await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
          return "skipped" as const;
        }
        let lastErr: unknown = null;
        let ok = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await enqueueReady(queue, route.outboxId, { backgroundJobId: route.jobId });
            ok = true;
            break;
          } catch (err) {
            lastErr = err;
            await sleep(Math.floor(Math.random() * 100) + 50 * 2 ** attempt);
          }
        }
        if (!ok) {
          await client.query("UPDATE outbox_events SET attempt_count = attempt_count + 1, last_error = 'transient_dispatch_failed' WHERE workspace_id = $1 AND id = $2", [
            route.workspaceId,
            route.outboxId,
          ]);
          throw lastErr instanceof Error ? lastErr : new Error("transient_dispatch_failed");
        }
        await client.query("UPDATE outbox_events SET published_at = now() WHERE workspace_id = $1 AND id = $2", [route.workspaceId, route.outboxId]);
        return "enqueued" as const;
      });
    } catch (err) {
      // The accepting member left the workspace: fail closed without
      // touching transport or tenant state. S02 owns reclaim/cancel for
      // orphaned routes; the row stays for diagnosis.
      if (err instanceof TenantDenied) {
        skipped += 1;
        continue;
      }
      throw err;
    }
    if (outcome === "skipped") skipped += 1;
    else enqueued += 1;
  }
  return { enqueued, skipped };
}

export type ProcessOutcome = "applied" | "duplicate-terminal-noop";

/**
 * Idempotent synthetic handler: QUEUED -> RUNNING -> SUCCEEDED with exactly
 * one immutable result row. Routes through the ID-only index, then runs the
 * transition inside withTenant with the recorded accepting member, so a
 * removed member fails closed (TenantDenied, job stays QUEUED for the S02
 * reclaim path) instead of running unscoped. Terminal jobs exit as no-ops
 * without touching effects and retire their index row. Crash rolls the
 * transaction back and the next delivery retries safely.
 */
export async function processImportJob(pool: Pool, backgroundJobId: string): Promise<ProcessOutcome> {
  if (!isUuid(backgroundJobId)) throw new TenantInvalid();
  const route = await resolveJobRoute(pool, backgroundJobId);
  if (!route) return "duplicate-terminal-noop";
  return withTenant(pool, { userId: route.acceptedBy, workspaceId: route.workspaceId }, async (client) => {
    const cur = await client.query("SELECT status FROM background_jobs WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
      route.workspaceId,
      backgroundJobId,
    ]);
    if ((cur.rowCount ?? 0) === 0) {
      await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, backgroundJobId]);
      return "duplicate-terminal-noop" as const;
    }
    const status = (cur.rows[0] as { status: string }).status;
    if (status !== "QUEUED") {
      await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, backgroundJobId]);
      return "duplicate-terminal-noop" as const;
    }
    await client.query(
      "UPDATE background_jobs SET status = 'RUNNING', started_at = now(), attempt_count = attempt_count + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2",
      [route.workspaceId, backgroundJobId],
    );
    await client.query(
      "INSERT INTO background_job_results (workspace_id, id, background_job_id, result_kind) VALUES ($1, $2, $3, 'synthetic-noop') ON CONFLICT (workspace_id, background_job_id) DO NOTHING",
      [route.workspaceId, uuidv7(), backgroundJobId],
    );
    const result = await client.query("SELECT id FROM background_job_results WHERE workspace_id = $1 AND background_job_id = $2", [
      route.workspaceId,
      backgroundJobId,
    ]);
    await client.query(
      "UPDATE background_jobs SET status = 'SUCCEEDED', completed_at = now(), result_ref = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2",
      [route.workspaceId, backgroundJobId, JSON.stringify({ backgroundJobResultId: (result.rows[0] as { id: string }).id })],
    );
    await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, backgroundJobId]);
    return "applied" as const;
  });
}
