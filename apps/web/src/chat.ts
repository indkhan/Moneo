// E04-S02 persistent chat with a worker-owned model loop (product §4;
// architecture §§139-174, 175-226; E02 durable job/fencing and E04-S01
// dispatch). Users create threads and turns over tenant-scoped HTTP; exactly
// one durable background job (chat.generate on the existing jobs machinery)
// owns generation per assistant turn, and reconnect resumes the authoritative
// saved activity cursor without duplicate effects. Worker death before/after
// dispatch publishes at most one assistant turn: attempts are fenced by the
// job generation, output is persisted per attempt (never concatenating
// independent attempts), and retry is always a visibly separate attempt and
// job. Every dispatch flows through the S01 shared boundary, so policy
// revocation, budgets, timeouts and unknown-usage accounting apply unchanged.
// Observability carries thread/turn/job/attempt ids, state transitions,
// counts and latency only — no bodies, prompts or finance payloads.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";
import { cancelDispatch, productionQualified, supersedeReservationTx, type DispatchTransport } from "./ai-dispatch.ts";
import { createToolContext, runToolLoop, type HistoryTurn, type LoopResult } from "./ai-tools.ts";
import {
  cancelJob,
  claimAttempt,
  fencedGuard,
  heartbeatAttempt,
  markAttempt,
  RecoveryError,
  type Claim,
} from "./job-recovery.ts";
import { resolveJobRoute, type JobRoute } from "./jobs.ts";

export const CHAT_SEND = "chat.send";
export const CHAT_RETRY = "chat.retry";
export const CHAT_JOB_TYPE = "chat.generate";
export const CHAT_JOB_VERSION = "1";
export const CHAT_MAX_TURNS = 200;
export const CHAT_USER_BODY_MAX_BYTES = 32 * 1024;
export const CHAT_ASSISTANT_BODY_MAX_BYTES = 64 * 1024;
export const CHAT_ACTIVITY_PAGE_MAX = 100;
export const CHAT_REPLAY_DAYS = 30;

export class ChatError extends Error {
  readonly code:
    | "not_found"
    | "thread_busy"
    | "turn_limit"
    | "invalid_state"
    | "idempotency_reuse"
    | "idempotency_expired";
  constructor(code: ChatError["code"]) {
    super(code);
    this.code = code;
  }
}

export type ThreadView = { workspaceId: string; id: string; title: string; status: "open" | "archived"; createdAt: string };
export type TurnView = {
  workspaceId: string;
  id: string;
  threadId: string;
  role: "user" | "assistant";
  status: "queued" | "running" | "completed" | "interrupted" | "failed" | "cancelled";
  body: string;
  jobId: string | null;
  createdAt: string;
};
export type AttemptView = {
  workspaceId: string;
  id: string;
  turnId: string;
  generation: number;
  status: "running" | "published" | "interrupted" | "failed" | "cancelled";
};
export type ActivityEvent = {
  seq: string;
  kind: "user-turn" | "assistant-queued" | "assistant-running" | "assistant-published" | "assistant-interrupted" | "assistant-failed" | "assistant-cancelled" | "retry";
  turnId: string | null;
  attemptId: string | null;
  createdAt: string;
};

function checkTitle(title: unknown): string {
  if (title === undefined) return "";
  if (typeof title !== "string" || title.length > 200) throw new TenantInvalid();
  return title;
}

function checkBody(body: unknown): string {
  if (typeof body !== "string" || body.length < 1 || Buffer.byteLength(body, "utf8") > CHAT_USER_BODY_MAX_BYTES) throw new TenantInvalid();
  return body;
}

function checkKey(key: unknown): string {
  if (typeof key !== "string" || key.length < 1 || key.length > 200) throw new TenantInvalid();
  return key;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToThread(row: { workspace_id: string; id: string; title: string; status: string; created_at: unknown }): ThreadView {
  return { workspaceId: row.workspace_id, id: row.id, title: row.title, status: row.status as ThreadView["status"], createdAt: iso(row.created_at) };
}

function rowToTurn(row: {
  workspace_id: string;
  id: string;
  thread_id: string;
  role: string;
  status: string;
  body: string;
  job_id: string | null;
  created_at: unknown;
}): TurnView {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    threadId: row.thread_id,
    role: row.role as TurnView["role"],
    status: row.status as TurnView["status"],
    body: row.body,
    jobId: row.job_id,
    createdAt: iso(row.created_at),
  };
}

/** Append one activity event; the thread row lock makes seq gapless per thread. */
async function appendActivity(
  client: PoolClient,
  workspaceId: string,
  threadId: string,
  kind: ActivityEvent["kind"],
  turnId: string | null,
  attemptId: string | null,
): Promise<void> {
  const next = await client.query("SELECT COALESCE(MAX(seq), 0)::bigint + 1 AS n FROM chat_activity WHERE workspace_id = $1 AND thread_id = $2", [
    workspaceId,
    threadId,
  ]);
  await client.query("INSERT INTO chat_activity (workspace_id, thread_id, seq, kind, turn_id, attempt_id) VALUES ($1, $2, $3, $4, $5, $6)", [
    workspaceId,
    threadId,
    (next.rows[0] as { n: string }).n,
    kind,
    turnId,
    attemptId,
  ]);
}

export async function createThread(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<ThreadView> {
  const title = checkTitle((raw as { title?: unknown } | null)?.title);
  if (!isUuid(actorId)) throw new TenantDenied();
  return withTenant(pool, claims, async (client) => {
    const id = uuidv7();
    const inserted = await client.query(
      "INSERT INTO chat_threads (workspace_id, id, title, status, created_by) VALUES ($1, $2, $3, 'open', $4) RETURNING workspace_id, id, title, status, created_at",
      [claims.workspaceId, id, title, actorId],
    );
    return rowToThread(inserted.rows[0] as Parameters<typeof rowToThread>[0]);
  });
}

export async function listThreads(pool: Pool, claims: TenantClaims): Promise<ThreadView[]> {
  return withTenant(pool, claims, async (client) => {
    const found = await client.query("SELECT workspace_id, id, title, status, created_at FROM chat_threads WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100", [
      claims.workspaceId,
    ]);
    return (found.rows as Parameters<typeof rowToThread>[0][]).map(rowToThread);
  });
}

export async function getThread(pool: Pool, claims: TenantClaims, threadId: string): Promise<{ thread: ThreadView; turns: TurnView[]; attempts: AttemptView[] } | null> {
  if (!isUuid(threadId)) return null;
  return withTenant(pool, claims, async (client) => {
    const thread = await client.query("SELECT workspace_id, id, title, status, created_at FROM chat_threads WHERE workspace_id = $1 AND id = $2", [
      claims.workspaceId,
      threadId,
    ]);
    if ((thread.rowCount ?? 0) === 0) return null;
    const turns = await client.query(
      "SELECT workspace_id, id, thread_id, role, status, body, job_id, created_at FROM chat_turns WHERE workspace_id = $1 AND thread_id = $2 ORDER BY created_at ASC, id ASC LIMIT 400",
      [claims.workspaceId, threadId],
    );
    const attempts = await client.query(
      "SELECT a.workspace_id, a.id, a.turn_id, a.generation, a.status FROM chat_attempts a JOIN chat_turns t ON t.workspace_id = a.workspace_id AND t.id = a.turn_id WHERE a.workspace_id = $1 AND t.thread_id = $2 ORDER BY a.created_at ASC, a.id ASC",
      [claims.workspaceId, threadId],
    );
    return {
      thread: rowToThread(thread.rows[0] as Parameters<typeof rowToThread>[0]),
      turns: (turns.rows as Parameters<typeof rowToTurn>[0][]).map(rowToTurn),
      attempts: (attempts.rows as { workspace_id: string; id: string; turn_id: string; generation: number; status: string }[]).map((r) => ({
        workspaceId: r.workspace_id,
        id: r.id,
        turnId: r.turn_id,
        generation: r.generation,
        status: r.status as AttemptView["status"],
      })),
    };
  });
}

export type SendResult = { userTurn: TurnView; assistantTurn: TurnView; jobId: string; operationId: string; replayed: boolean };

function sendHash(threadId: string, body: string): string {
  return createHash("sha256").update(JSON.stringify({ command: CHAT_SEND, threadId, body })).digest("hex");
}

async function sendTx(
  client: PoolClient,
  claims: TenantClaims,
  actorId: string,
  threadId: string,
  body: string,
  key: string,
): Promise<{ ok: true; result: SendResult } | { ok: false; code: ChatError["code"] }> {
  const hash = sendHash(threadId, body);
  const readOp = async () => {
    const found = await client.query(
      'SELECT id AS "operationId", status, request_hash AS "requestHash", response_payload AS "response", error_payload AS "error", expires_at AS "expiresAt" FROM command_operations WHERE workspace_id = $1 AND command_name = $2 AND idempotency_key = $3',
      [claims.workspaceId, CHAT_SEND, key],
    );
    return found.rows[0] as { operationId: string; status: string; requestHash: string; response: unknown; error: { code: ChatError["code"] } | null; expiresAt: string } | undefined;
  };
  const settle = async (row: NonNullable<Awaited<ReturnType<typeof readOp>>>): Promise<{ ok: true; result: SendResult } | { ok: false; code: ChatError["code"] }> => {
    if (new Date(row.expiresAt).getTime() <= Date.now()) return { ok: false, code: "idempotency_expired" };
    if (row.requestHash !== hash) return { ok: false, code: "idempotency_reuse" };
    if (row.status === "SUCCEEDED") {
      const resumed = row.response as { userTurnId: string; assistantTurnId: string; jobId: string } | null;
      if (!resumed) return { ok: false, code: "not_found" };
      const turns = await client.query("SELECT workspace_id, id, thread_id, role, status, body, job_id, created_at FROM chat_turns WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [
        claims.workspaceId,
        [resumed.userTurnId, resumed.assistantTurnId],
      ]);
      const byId = new Map((turns.rows as Parameters<typeof rowToTurn>[0][]).map((r) => [r.id, rowToTurn(r)]));
      const userTurn = byId.get(resumed.userTurnId);
      const assistantTurn = byId.get(resumed.assistantTurnId);
      if (!userTurn || !assistantTurn) return { ok: false, code: "not_found" };
      return { ok: true, result: { userTurn, assistantTurn, jobId: resumed.jobId, operationId: row.operationId, replayed: true } };
    }
    return { ok: false, code: row.error?.code ?? "idempotency_reuse" };
  };

  const prior = await readOp();
  if (prior) return settle(prior);

  const operationId = uuidv7();
  await client.query("SAVEPOINT chat_send_claim");
  let claimed = false;
  try {
    await client.query(
      "INSERT INTO command_operations (workspace_id, id, command_name, idempotency_key, request_hash, actor_id, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'FAILED_FINAL', now() + ($7 || ' days')::interval)",
      [claims.workspaceId, operationId, CHAT_SEND, key, hash, actorId, String(CHAT_REPLAY_DAYS)],
    );
    claimed = true;
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    await client.query("ROLLBACK TO SAVEPOINT chat_send_claim");
  }
  if (!claimed) {
    let row: Awaited<ReturnType<typeof readOp>>;
    for (let poll = 0; poll < 20; poll++) {
      row = await readOp();
      if (row) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (row) return settle(row);
    return { ok: false, code: "idempotency_reuse" };
  }
  const fail = async (code: ChatError["code"]): Promise<{ ok: false; code: ChatError["code"] }> => {
    await client.query("UPDATE command_operations SET status = 'FAILED_FINAL', error_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
      JSON.stringify({ code }),
      claims.workspaceId,
      operationId,
    ]);
    return { ok: false, code };
  };

  // Serialize admissions on the thread row: concurrent sends then observe the
  // winner's assistant turn and fail typed thread_busy instead of racing
  // into a raw unique violation (B1). The same lock makes the activity seq
  // genuinely gapless per thread, as appendActivity assumes.
  const thread = await client.query("SELECT id FROM chat_threads WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [claims.workspaceId, threadId]);
  if ((thread.rowCount ?? 0) === 0) return fail("not_found");
  const counted = await client.query("SELECT count(*)::int AS n FROM chat_turns WHERE workspace_id = $1 AND thread_id = $2", [claims.workspaceId, threadId]);
  if (((counted.rows[0] as { n: number }).n) + 2 > CHAT_MAX_TURNS) return fail("turn_limit");
  const active = await client.query(
    "SELECT 1 FROM chat_turns WHERE workspace_id = $1 AND thread_id = $2 AND role = 'assistant' AND status IN ('queued', 'running')",
    [claims.workspaceId, threadId],
  );
  if ((active.rowCount ?? 0) > 0) return fail("thread_busy");

  const userTurnId = uuidv7();
  const assistantTurnId = uuidv7();
  const jobId = uuidv7();
  const outboxId = uuidv7();
  await client.query(
    "INSERT INTO chat_turns (workspace_id, id, thread_id, role, status, body, job_id, idempotency_key) VALUES ($1, $2, $3, 'user', 'completed', $4, NULL, $5)",
    [claims.workspaceId, userTurnId, threadId, body, `chat.send:user:${key}`],
  );
  await client.query(
    "INSERT INTO chat_turns (workspace_id, id, thread_id, role, status, body, job_id, idempotency_key) VALUES ($1, $2, $3, 'assistant', 'queued', '', $4, $5)",
    [claims.workspaceId, assistantTurnId, threadId, jobId, `chat.send:assistant:${key}`],
  );
  await client.query(
    "INSERT INTO background_jobs (workspace_id, id, job_type, job_version, status, deduplication_key, command_operation_id, input_ref) VALUES ($1, $2, 'chat.generate', '1', 'QUEUED', $3, $4, $5)",
    [claims.workspaceId, jobId, `${CHAT_JOB_TYPE}:${key}`, operationId, JSON.stringify({ threadId, assistantTurnId })],
  );
  const payload = JSON.stringify({ backgroundJobId: jobId });
  if (Buffer.byteLength(payload, "utf8") > 1024) throw new Error("job payload exceeds 1 KiB");
  await client.query("INSERT INTO outbox_events (workspace_id, id, event_type, aggregate_type, aggregate_id, payload) VALUES ($1, $2, 'job.ready', 'background_job', $3, $4)", [
    claims.workspaceId,
    outboxId,
    jobId,
    payload,
  ]);
  await client.query("INSERT INTO job_dispatch_index (workspace_id, job_id, outbox_id, accepted_by) VALUES ($1, $2, $3, $4)", [
    claims.workspaceId,
    jobId,
    outboxId,
    actorId,
  ]);
  await appendActivity(client, claims.workspaceId, threadId, "user-turn", userTurnId, null);
  await appendActivity(client, claims.workspaceId, threadId, "assistant-queued", assistantTurnId, null);
  const turns = await client.query("SELECT workspace_id, id, thread_id, role, status, body, job_id, created_at FROM chat_turns WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [
    claims.workspaceId,
    [userTurnId, assistantTurnId],
  ]);
  const byId = new Map((turns.rows as Parameters<typeof rowToTurn>[0][]).map((r) => [r.id, rowToTurn(r)]));
  await client.query("UPDATE command_operations SET status = 'SUCCEEDED', response_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
    JSON.stringify({ userTurnId, assistantTurnId, jobId }),
    claims.workspaceId,
    operationId,
  ]);
  return {
    ok: true,
    result: { userTurn: byId.get(userTurnId)!, assistantTurn: byId.get(assistantTurnId)!, jobId, operationId, replayed: false },
  };
}

export async function sendTurn(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<SendResult> {
  const input = raw as { threadId?: unknown; body?: unknown; idempotencyKey?: unknown };
  if (typeof input.threadId !== "string" || !isUuid(input.threadId)) throw new TenantDenied();
  const body = checkBody(input.body);
  const key = checkKey(input.idempotencyKey);
  if (!isUuid(actorId)) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => sendTx(client, claims, actorId, input.threadId as string, body, key));
  if (!outcome.ok) throw new ChatError(outcome.code);
  return outcome.result;
}

/** Resumable ordered activity read: events after afterSeq, up to limit (≤100). */
export async function readActivity(
  pool: Pool,
  claims: TenantClaims,
  threadId: string,
  afterSeq = 0,
  limit = 100,
): Promise<{ events: ActivityEvent[]; nextCursor: string }> {
  if (!isUuid(threadId)) throw new TenantDenied();
  if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new TenantInvalid();
  if (!Number.isInteger(limit) || limit < 1 || limit > CHAT_ACTIVITY_PAGE_MAX) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    const thread = await client.query("SELECT id FROM chat_threads WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, threadId]);
    if ((thread.rowCount ?? 0) === 0) throw new TenantDenied();
    const found = await client.query(
      "SELECT seq, kind, turn_id, attempt_id, created_at FROM chat_activity WHERE workspace_id = $1 AND thread_id = $2 AND seq > $3 ORDER BY seq ASC LIMIT $4",
      [claims.workspaceId, threadId, String(afterSeq), limit],
    );
    const events = (found.rows as { seq: string; kind: string; turn_id: string | null; attempt_id: string | null; created_at: unknown }[]).map((r) => ({
      seq: String(r.seq),
      kind: r.kind as ActivityEvent["kind"],
      turnId: r.turn_id,
      attemptId: r.attempt_id,
      createdAt: iso(r.created_at),
    }));
    const nextCursor = events.length > 0 ? events[events.length - 1].seq : String(afterSeq);
    return { events, nextCursor };
  });
}

export type RetryResult = { assistantTurn: TurnView; jobId: string; operationId: string; replayed: boolean };

/** Retry a settled assistant turn: new job + new attempt generation, never a rewrite. */
export async function retryTurn(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<RetryResult> {
  const input = raw as { turnId?: unknown; idempotencyKey?: unknown };
  if (typeof input.turnId !== "string" || !isUuid(input.turnId)) throw new TenantDenied();
  const key = checkKey(input.idempotencyKey);
  if (!isUuid(actorId)) throw new TenantDenied();
  return withTenant(pool, claims, async (client) => {
    const hash = createHash("sha256").update(JSON.stringify({ command: CHAT_RETRY, turnId: input.turnId, key })).digest("hex");
    const prior = await client.query(
      'SELECT id AS "operationId", status, request_hash AS "requestHash", response_payload AS "response", error_payload AS "error", expires_at AS "expiresAt" FROM command_operations WHERE workspace_id = $1 AND command_name = $2 AND idempotency_key = $3',
      [claims.workspaceId, CHAT_RETRY, key],
    );
    const settlePrior = async (row: { operationId: string; status: string; requestHash: string; response: unknown; error: { code: ChatError["code"] } | null; expiresAt: string }): Promise<RetryResult> => {
      if (new Date(row.expiresAt).getTime() <= Date.now()) throw new ChatError("idempotency_expired");
      if (row.requestHash !== hash) throw new ChatError("idempotency_reuse");
      if (row.status !== "SUCCEEDED") throw new ChatError(row.error?.code ?? "idempotency_reuse");
      const resumed = row.response as { assistantTurnId: string; jobId: string };
      const turn = await client.query("SELECT workspace_id, id, thread_id, role, status, body, job_id, created_at FROM chat_turns WHERE workspace_id = $1 AND id = $2", [
        claims.workspaceId,
        resumed.assistantTurnId,
      ]);
      if ((turn.rowCount ?? 0) === 0) throw new ChatError("not_found");
      return { assistantTurn: rowToTurn(turn.rows[0] as Parameters<typeof rowToTurn>[0]), jobId: resumed.jobId, operationId: row.operationId, replayed: true };
    };
    if ((prior.rowCount ?? 0) > 0) return settlePrior(prior.rows[0] as Parameters<typeof settlePrior>[0]);
    const operationId = uuidv7();
    await client.query("SAVEPOINT chat_retry_claim");
    let claimed = false;
    try {
      await client.query(
        "INSERT INTO command_operations (workspace_id, id, command_name, idempotency_key, request_hash, actor_id, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'FAILED_FINAL', now() + ($7 || ' days')::interval)",
        [claims.workspaceId, operationId, CHAT_RETRY, key, hash, actorId, String(CHAT_REPLAY_DAYS)],
      );
      claimed = true;
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      await client.query("ROLLBACK TO SAVEPOINT chat_retry_claim");
    }
    if (!claimed) throw new ChatError("idempotency_reuse");
    const fail = async (code: ChatError["code"]): Promise<never> => {
      await client.query("UPDATE command_operations SET status = 'FAILED_FINAL', error_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
        JSON.stringify({ code }),
        claims.workspaceId,
        operationId,
      ]);
      throw new ChatError(code);
    };
    const turn = await client.query("SELECT workspace_id, id, thread_id, role, status, body, job_id, created_at FROM chat_turns WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
      claims.workspaceId,
      input.turnId,
    ]);
    if ((turn.rowCount ?? 0) === 0) await fail("not_found");
    // Serialize with concurrent sends/retries on the same thread (B1).
    await client.query("SELECT id FROM chat_threads WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
      claims.workspaceId,
      (turn.rows[0] as { thread_id: string }).thread_id,
    ]);
    const row = rowToTurn(turn.rows[0] as Parameters<typeof rowToTurn>[0]);
    if (row.role !== "assistant" || row.status === "queued" || row.status === "running" || row.status === "completed") await fail("invalid_state");
    const busy = await client.query(
      "SELECT 1 FROM chat_turns WHERE workspace_id = $1 AND thread_id = $2 AND role = 'assistant' AND status IN ('queued', 'running') AND id <> $3",
      [claims.workspaceId, row.threadId, row.id],
    );
    if ((busy.rowCount ?? 0) > 0) await fail("thread_busy");
    const jobId = uuidv7();
    const outboxId = uuidv7();
    await client.query("UPDATE chat_turns SET status = 'queued', job_id = $3 WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, row.id, jobId]);
    await client.query(
      "INSERT INTO background_jobs (workspace_id, id, job_type, job_version, status, deduplication_key, command_operation_id, input_ref) VALUES ($1, $2, 'chat.generate', '1', 'QUEUED', $3, $4, $5)",
      [claims.workspaceId, jobId, `${CHAT_JOB_TYPE}:retry:${key}`, operationId, JSON.stringify({ threadId: row.threadId, assistantTurnId: row.id })],
    );
    const payload = JSON.stringify({ backgroundJobId: jobId });
    await client.query("INSERT INTO outbox_events (workspace_id, id, event_type, aggregate_type, aggregate_id, payload) VALUES ($1, $2, 'job.ready', 'background_job', $3, $4)", [
      claims.workspaceId,
      outboxId,
      jobId,
      payload,
    ]);
    await client.query("INSERT INTO job_dispatch_index (workspace_id, job_id, outbox_id, accepted_by) VALUES ($1, $2, $3, $4)", [
      claims.workspaceId,
      jobId,
      outboxId,
      actorId,
    ]);
    await appendActivity(client, claims.workspaceId, row.threadId, "retry", row.id, null);
    const updated = await client.query("SELECT workspace_id, id, thread_id, role, status, body, job_id, created_at FROM chat_turns WHERE workspace_id = $1 AND id = $2", [
      claims.workspaceId,
      row.id,
    ]);
    await client.query("UPDATE command_operations SET status = 'SUCCEEDED', response_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
      JSON.stringify({ assistantTurnId: row.id, jobId }),
      claims.workspaceId,
      operationId,
    ]);
    return { assistantTurn: rowToTurn(updated.rows[0] as Parameters<typeof rowToTurn>[0]), jobId, operationId, replayed: false };
  });
}

export type CancelTurnResult = { status: TurnView["status"]; changed: boolean };

/** Cooperative cancel: the job cancel wins at the next fence; an already
 * published turn is never unpublished. Idempotent. Runs in three short
 * transactions (read, durable job cancel, finalize) so the shared cancelJob
 * path — which owns its own transaction — is reused without nesting. */
export async function cancelTurn(pool: Pool, claims: TenantClaims, turnId: string): Promise<CancelTurnResult> {
  if (!isUuid(turnId)) throw new TenantDenied();
  const snapshot = await withTenant(pool, claims, async (client) => {
    const turn = await client.query("SELECT id, thread_id, role, status, job_id FROM chat_turns WHERE workspace_id = $1 AND id = $2", [
      claims.workspaceId,
      turnId,
    ]);
    if ((turn.rowCount ?? 0) === 0) throw new TenantDenied();
    return turn.rows[0] as { id: string; thread_id: string; role: string; status: string; job_id: string | null };
  });
  if (snapshot.status !== "queued" && snapshot.status !== "running") return { status: snapshot.status as TurnView["status"], changed: false };
  // Cancel the S01 reservation behind the latest attempt first: no later
  // dispatch may start, while accepted provider work stays accounted.
  const latest = await withTenant(pool, claims, async (client) => {
    const found = await client.query("SELECT id FROM chat_attempts WHERE workspace_id = $1 AND turn_id = $2 AND status = 'running' ORDER BY created_at DESC LIMIT 1", [
      claims.workspaceId,
      turnId,
    ]);
    return (found.rows[0] as { id: string } | undefined)?.id ?? null;
  });
  if (latest) await cancelAttemptReservation(pool, claims, latest);
  if (snapshot.job_id) await cancelJob(pool, claims, snapshot.job_id);
  return withTenant(pool, claims, async (client) => {
    const current = await client.query("SELECT status, thread_id FROM chat_turns WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
      claims.workspaceId,
      turnId,
    ]);
    const cur = current.rows[0] as { status: string; thread_id: string };
    if (cur.status !== "queued" && cur.status !== "running") return { status: cur.status as TurnView["status"], changed: false };
    await client.query("UPDATE chat_turns SET status = 'cancelled' WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, turnId]);
    await client.query("UPDATE chat_attempts SET status = 'cancelled', completed_at = now() WHERE workspace_id = $1 AND turn_id = $2 AND status = 'running'", [
      claims.workspaceId,
      turnId,
    ]);
    await appendActivity(client, claims.workspaceId, cur.thread_id, "assistant-cancelled", turnId, null);
    return { status: "cancelled" as const, changed: true };
  });
}

export function chatErrorBody(err: ChatError): { status: number; body: unknown } {
  switch (err.code) {
    case "not_found":
      return { status: 404, body: { error: "not_found" } };
    case "thread_busy":
      return { status: 409, body: { error: "thread_busy" } };
    case "turn_limit":
      return { status: 409, body: { error: "turn_limit" } };
    case "invalid_state":
      return { status: 409, body: { error: "invalid_state" } };
    case "idempotency_reuse":
      return { status: 409, body: { error: "idempotency_reuse" } };
    case "idempotency_expired":
      return { status: 409, body: { error: "idempotency_expired" } };
  }
}

// ---- Worker-owned generation loop ----

export type ChatOutcome = "applied" | "duplicate-terminal-noop" | "deferred";

/** Narrow job input: thread + assistant turn UUIDs only. */
async function readChatInput(pool: Pool, route: JobRoute, jobId: string): Promise<{ threadId: string; assistantTurnId: string } | null> {
  return withTenant(pool, { userId: route.acceptedBy, workspaceId: route.workspaceId }, async (client) => {
    const found = await client.query("SELECT input_ref FROM background_jobs WHERE workspace_id = $1 AND id = $2", [route.workspaceId, jobId]);
    if ((found.rowCount ?? 0) === 0) return null;
    const ref = (found.rows[0] as { input_ref: { threadId?: unknown; assistantTurnId?: unknown } }).input_ref;
    if (typeof ref.threadId !== "string" || !isUuid(ref.threadId) || typeof ref.assistantTurnId !== "string" || !isUuid(ref.assistantTurnId)) return null;
    return { threadId: ref.threadId, assistantTurnId: ref.assistantTurnId };
  });
}

async function failTurnFenced(
  pool: Pool,
  route: JobRoute & { jobId: string },
  claim: Pick<Claim, "attemptId" | "generation">,
  turnId: string,
  attemptId: string,
  errorClass: string,
): Promise<void> {
  await withTenant(pool, { userId: route.acceptedBy, workspaceId: route.workspaceId }, async (client) => {
    const guard = await fencedGuard(client, route, claim);
    if (!guard.ok) {
      // No turn/attempt transition here by design (N1): cancelTurn's
      // finalize owns the cancelled state and both interleavings converge;
      // only the job attempt row is marked.
      await markAttempt(client, route, claim.attemptId, guard.reason === "cancelled" ? "CANCELLED" : "STALE");
      return;
    }
    const terminal = await client.query(
      "UPDATE background_jobs SET status = 'FAILED_FINAL', completed_at = now(), error_code = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'RUNNING' AND attempt_generation = $4 AND cancel_requested_at IS NULL",
      [route.workspaceId, route.jobId, errorClass.slice(0, 60), claim.generation],
    );
    if ((terminal.rowCount ?? 0) !== 1) {
      await markAttempt(client, route, claim.attemptId, "STALE");
      return;
    }
    await client.query("UPDATE chat_turns SET status = 'failed' WHERE workspace_id = $1 AND id = $2 AND status IN ('queued', 'running')", [
      route.workspaceId,
      turnId,
    ]);
    await client.query("UPDATE chat_attempts SET status = 'failed', completed_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'running'", [
      route.workspaceId,
      attemptId,
    ]);
    const thread = await client.query("SELECT thread_id FROM chat_turns WHERE workspace_id = $1 AND id = $2", [route.workspaceId, turnId]);
    if ((thread.rowCount ?? 0) > 0) {
      await appendActivity(client, route.workspaceId, (thread.rows[0] as { thread_id: string }).thread_id, "assistant-failed", turnId, attemptId);
    }
    await markAttempt(client, route, claim.attemptId, "SUCCEEDED");
    await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
  });
}

/** Settle one generation ambiguously: turn interrupted, attempt interrupted,
 * job SUCCEEDED (the generation finished without an authoritative result).
 * Retry is a new job + new attempt, never a rewrite. */
async function interruptTurnFenced(
  pool: Pool,
  route: JobRoute & { jobId: string },
  claim: Pick<Claim, "attemptId" | "generation">,
  turnId: string,
  attemptId: string,
): Promise<void> {
  await withTenant(pool, { userId: route.acceptedBy, workspaceId: route.workspaceId }, async (client) => {
    const guard = await fencedGuard(client, route, claim);
    if (!guard.ok) {
      await markAttempt(client, route, claim.attemptId, guard.reason === "cancelled" ? "CANCELLED" : "STALE");
      if (guard.reason === "cancelled") {
        await client.query("UPDATE chat_turns SET status = 'cancelled' WHERE workspace_id = $1 AND id = $2 AND status IN ('queued', 'running')", [
          route.workspaceId,
          turnId,
        ]);
        await client.query("UPDATE chat_attempts SET status = 'cancelled', completed_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'running'", [
          route.workspaceId,
          attemptId,
        ]);
      }
      return;
    }
    const terminal = await client.query(
      "UPDATE background_jobs SET status = 'SUCCEEDED', completed_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'RUNNING' AND attempt_generation = $3 AND cancel_requested_at IS NULL",
      [route.workspaceId, route.jobId, claim.generation],
    );
    if ((terminal.rowCount ?? 0) !== 1) {
      await markAttempt(client, route, claim.attemptId, "STALE");
      return;
    }
    await client.query("UPDATE chat_turns SET status = 'interrupted' WHERE workspace_id = $1 AND id = $2 AND status IN ('queued', 'running')", [
      route.workspaceId,
      turnId,
    ]);
    await client.query("UPDATE chat_attempts SET status = 'interrupted', completed_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'running'", [
      route.workspaceId,
      attemptId,
    ]);
    const thread = await client.query("SELECT thread_id FROM chat_turns WHERE workspace_id = $1 AND id = $2", [route.workspaceId, turnId]);
    if ((thread.rowCount ?? 0) > 0) {
      await appendActivity(client, route.workspaceId, (thread.rows[0] as { thread_id: string }).thread_id, "assistant-interrupted", turnId, attemptId);
    }
    await markAttempt(client, route, claim.attemptId, "SUCCEEDED");
    await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
  });
}

/**
 * Fenced terminal publish. When expected tool-run versions are supplied, the
 * publish transaction itself re-reads the live policy version (locked,
 * serializing with exclusion writers) and data revision: drift since the
 * run's final gate aborts publication instead of landing stale tool-derived
 * text (B3). The caller maps the stale outcome to an interrupted turn, so
 * retry stays a visibly separate attempt.
 */
export async function publishTurnFenced(
  pool: Pool,
  route: JobRoute & { jobId: string },
  claim: Pick<Claim, "attemptId" | "generation">,
  turnId: string,
  attemptId: string,
  body: string,
  expected?: { policyVersion: string; revision: string },
): Promise<{ ok: true } | { ok: false; stale?: true }> {
  return withTenant(pool, { userId: route.acceptedBy, workspaceId: route.workspaceId }, async (client) => {
    const guard = await fencedGuard(client, route, claim);
    if (!guard.ok) {
      await markAttempt(client, route, claim.attemptId, guard.reason === "cancelled" ? "CANCELLED" : "STALE");
      if (guard.reason === "cancelled") {
        await client.query("UPDATE chat_turns SET status = 'cancelled' WHERE workspace_id = $1 AND id = $2 AND status IN ('queued', 'running')", [
          route.workspaceId,
          turnId,
        ]);
        await client.query("UPDATE chat_attempts SET status = 'cancelled', completed_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'running'", [
          route.workspaceId,
          attemptId,
        ]);
      }
      return { ok: false as const };
    }
    if (expected !== undefined) {
      await client.query("INSERT INTO ai_policies (workspace_id, policy_version) VALUES ($1, 1) ON CONFLICT (workspace_id) DO NOTHING", [route.workspaceId]);
      const policy = await client.query("SELECT policy_version AS v FROM ai_policies WHERE workspace_id = $1 FOR UPDATE", [route.workspaceId]);
      const liveVersion = (policy.rowCount ?? 0) === 0 ? "1" : String((policy.rows[0] as { v: string }).v);
      const revision = await client.query("SELECT revision AS r FROM workspace_data_revision WHERE workspace_id = $1", [route.workspaceId]);
      const liveRevision = (revision.rowCount ?? 0) === 0 ? "0" : String((revision.rows[0] as { r: string }).r);
      if (liveVersion !== expected.policyVersion || liveRevision !== expected.revision) return { ok: false as const, stale: true as const };
    }
    if (Buffer.byteLength(body, "utf8") > CHAT_ASSISTANT_BODY_MAX_BYTES) {
      await markAttempt(client, route, claim.attemptId, "STALE");
      return { ok: false as const };
    }
    const terminal = await client.query(
      "UPDATE background_jobs SET status = 'SUCCEEDED', completed_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'RUNNING' AND attempt_generation = $3 AND cancel_requested_at IS NULL",
      [route.workspaceId, route.jobId, claim.generation],
    );
    if ((terminal.rowCount ?? 0) !== 1) {
      await markAttempt(client, route, claim.attemptId, "STALE");
      return { ok: false as const };
    }
    // Predicated turn write: exactly one generation publishes. A concurrent
    // publisher (or a cancel that won the fence) leaves zero rows and the
    // attempt goes STALE instead of duplicating the turn.
    const published = await client.query(
      "UPDATE chat_turns SET status = 'completed', body = $3 WHERE workspace_id = $1 AND id = $2 AND status IN ('queued', 'running')",
      [route.workspaceId, turnId, body],
    );
    if ((published.rowCount ?? 0) !== 1) {
      await markAttempt(client, route, claim.attemptId, "STALE");
      return { ok: false as const };
    }
    await client.query("UPDATE chat_attempts SET status = 'published', completed_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'running'", [
      route.workspaceId,
      attemptId,
    ]);
    const thread = await client.query("SELECT thread_id FROM chat_turns WHERE workspace_id = $1 AND id = $2", [route.workspaceId, turnId]);
    if ((thread.rowCount ?? 0) > 0) {
      await appendActivity(client, route.workspaceId, (thread.rows[0] as { thread_id: string }).thread_id, "assistant-published", turnId, attemptId);
    }
    await markAttempt(client, route, claim.attemptId, "SUCCEEDED");
    await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
    return { ok: true as const };
  });
}

export type ClaimedGeneration = {
  route: JobRoute;
  full: JobRoute & { jobId: string };
  claim: Claim;
  input: { threadId: string; assistantTurnId: string };
  attemptId: string;
};

/**
 * Fenced claim of one generation: background-job generation + this turn's
 * attempt row + turn running + activity, atomically. Returns null when a
 * live generation owns the turn (this delivery stands down as a duplicate).
 * Exported so the fault-injection child drives the exact same boundary the
 * worker uses before it is SIGKILLed.
 */
export async function claimChatGeneration(
  pool: Pool,
  backgroundJobId: string,
  opts?: { workerId?: string; leaseMs?: number; bullmqJobId?: string },
): Promise<ClaimedGeneration | null> {
  if (!isUuid(backgroundJobId)) throw new TenantInvalid();
  const route = await resolveJobRoute(pool, backgroundJobId);
  if (!route) return null;
  const full = { ...route, jobId: backgroundJobId };
  const workerClaims = { userId: route.acceptedBy, workspaceId: route.workspaceId };
  const input = await readChatInput(pool, route, backgroundJobId);
  if (!input) return null;
  let claim: Claim;
  try {
    claim = await claimAttempt(pool, full, opts?.workerId ?? `chat-worker-${process.pid}`, opts?.leaseMs ?? 30_000, opts?.bullmqJobId);
  } catch (err) {
    if (err instanceof RecoveryError && (err.code === "not_found" || err.code === "terminal" || err.code === "cancelled")) return null;
    throw err;
  }
  // Register this generation's attempt; supersede any still-running row from
  // a dead generation. The partial unique index is the backstop: a 23505
  // here means a live generation owns the turn, so this one stands down.
  const attemptId = uuidv7();
  const registered = await withTenant(pool, workerClaims, async (client) => {
    // Supersede still-running rows from dead generations, and settle their
    // reservations as PENDING-held in the same transaction: a dead RESERVED
    // row must never leak its slot/money forever, nor be blindly released
    // while mid-transport ambiguity is possible (B2).
    const dead = await client.query("SELECT id, reservation_id FROM chat_attempts WHERE workspace_id = $1 AND turn_id = $2 AND status = 'running'", [
      route.workspaceId,
      input.assistantTurnId,
    ]);
    for (const row of dead.rows as { id: string; reservation_id: string | null }[]) {
      if (row.reservation_id) await supersedeReservationTx(client, route.workspaceId, row.reservation_id);
    }
    await client.query("UPDATE chat_attempts SET status = 'interrupted', completed_at = now() WHERE workspace_id = $1 AND turn_id = $2 AND status = 'running'", [
      route.workspaceId,
      input.assistantTurnId,
    ]);
    await client.query("SAVEPOINT chat_attempt_claim");
    try {
      await client.query(
        "INSERT INTO chat_attempts (workspace_id, id, turn_id, generation, status) VALUES ($1, $2, $3, $4, 'running')",
        [route.workspaceId, attemptId, input.assistantTurnId, claim.generation],
      );
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      await client.query("ROLLBACK TO SAVEPOINT chat_attempt_claim");
      return false;
    }
    await client.query("RELEASE SAVEPOINT chat_attempt_claim");
    await client.query("UPDATE chat_turns SET status = 'running' WHERE workspace_id = $1 AND id = $2 AND status = 'queued'", [
      route.workspaceId,
      input.assistantTurnId,
    ]);
    await appendActivity(client, route.workspaceId, input.threadId, "assistant-running", input.assistantTurnId, attemptId);
    return true;
  });
  if (!registered) {
    await withTenant(pool, workerClaims, async (client) => markAttempt(client, full, claim.attemptId, "STALE"));
    return null;
  }
  return { route, full, claim, input, attemptId };
}

/**
 * Drive one claimed generation through the S03 model/tool loop to a fenced
 * publish. Every step dispatches fresh under S01 (new reservation, policy
 * rechecked); a death anywhere publishes at most one turn, the dead attempt
 * is marked interrupted, and retry is always a visibly separate attempt.
 */
export async function driveChatGeneration(
  pool: Pool,
  claimed: ClaimedGeneration,
  transport: DispatchTransport | null,
): Promise<ChatOutcome> {
  const { route, full, claim, input, attemptId } = claimed;
  const workerClaims = { userId: route.acceptedBy, workspaceId: route.workspaceId };
  const pick = { attemptId: claim.attemptId, generation: claim.generation };

  if (!transport) {
    // No provider transport configured: stay RUNNING for the sweep to
    // redeliver once configured (same deferral shape as upload config).
    return "deferred";
  }

  // History for the prompt: completed turns only, in order. The pending user
  // turn is always included; interrupted/failed generations contribute no
  // text (their bytes were never authoritative).
  const view = await getThread(pool, workerClaims, input.threadId);
  if (!view) {
    await interruptTurnFenced(pool, full, pick, input.assistantTurnId, attemptId);
    return "applied";
  }
  const history = view.turns
    .filter((t) => t.status === "completed" && t.body.length > 0)
    .map((t) => ({ role: t.role, body: t.body }));
  const ctx = await createToolContext(pool, workerClaims).catch(() => null);
  if (!ctx) {
    await interruptTurnFenced(pool, full, pick, input.assistantTurnId, attemptId);
    return "applied";
  }
  await withTenant(pool, workerClaims, async (client) => {
    await client.query("UPDATE chat_attempts SET reservation_id = NULL, policy_version = $3 WHERE workspace_id = $1 AND id = $2", [
      route.workspaceId,
      attemptId,
      ctx.policyVersion,
    ]);
  });
  await heartbeatAttempt(pool, full, claim.attemptId);

  // Recording transport: persist each step's output onto this attempt before
  // S01 settles, so this generation publishes its own authoritative result.
  // Fenced by the live generation: a superseded worker persists nothing,
  // and recovery always dispatches fresh under a new attempt.
  const recording: DispatchTransport = async (req, signal) => {
    const result = await transport(req, signal);
    if (result.bodyText !== null && result.httpStatus !== null && result.httpStatus >= 200 && result.httpStatus < 300) {
      // Slice at the publish cap: anything larger could never publish, so it
      // must not linger as unpublishable attempt state (N2).
      const text = result.bodyText.slice(0, CHAT_ASSISTANT_BODY_MAX_BYTES);
      await withTenant(pool, workerClaims, async (client) => {
        const live = await client.query("SELECT attempt_generation, status FROM background_jobs WHERE workspace_id = $1 AND id = $2", [
          route.workspaceId,
          full.jobId,
        ]);
        if ((live.rowCount ?? 0) === 0) return;
        const job = live.rows[0] as { attempt_generation: string; status: string };
        if (job.status !== "RUNNING" || Number(job.attempt_generation) !== claim.generation) return;
        await client.query("UPDATE chat_attempts SET output_text = $3 WHERE workspace_id = $1 AND id = $2 AND status = 'running'", [
          route.workspaceId,
          attemptId,
          text,
        ]);
      });
    }
    return result;
  };

  let run: LoopResult;
  try {
    // Route selection restores the S01 invariant (B2): production only when
    // qualified, never a silent fallback to the training-permitted route.
    const dispatchRoute = productionQualified() ? "production" : "development";
    run = await runToolLoop(pool, ctx, attemptId, `chat:${attemptId}`, history, recording, { route: dispatchRoute }, {
      onReservation: async (reservationId) => {
        await withTenant(pool, workerClaims, async (client) => {
          await client.query("UPDATE chat_attempts SET reservation_id = $3 WHERE workspace_id = $1 AND id = $2", [
            route.workspaceId,
            attemptId,
            reservationId,
          ]);
        });
      },
      isLive: async () => {
        const live = await withTenant(pool, workerClaims, async (client) => {
          const found = await client.query("SELECT status FROM chat_turns WHERE workspace_id = $1 AND id = $2", [route.workspaceId, input.assistantTurnId]);
          return (found.rows[0] as { status: string } | undefined)?.status;
        });
        return live === "queued" || live === "running";
      },
    });
  } catch {
    await interruptTurnFenced(pool, full, pick, input.assistantTurnId, attemptId);
    return "applied";
  }
  await heartbeatAttempt(pool, full, claim.attemptId);

  if (run.status === "ok") {
    // Only this attempt's own final may publish: independent attempts are
    // never concatenated, and a generation without its own authoritative
    // result settles ambiguously for a visibly separate retry. A stale
    // publish gate interrupts instead of duplicating or landing old text.
    const published = await publishTurnFenced(pool, full, pick, input.assistantTurnId, attemptId, run.finalText, {
      policyVersion: run.policyVersion,
      revision: run.revision,
    });
    if (published.ok) return "applied";
    if (published.stale) {
      await interruptTurnFenced(pool, full, pick, input.assistantTurnId, attemptId);
      return "applied";
    }
    return "duplicate-terminal-noop";
  }
  if (run.status === "failed") {
    await failTurnFenced(pool, full, pick, input.assistantTurnId, attemptId, run.errorClass);
    return "applied";
  }
  // stale/limit/aborted/interrupted: no authoritative result for this
  // generation; policy/revision drift already blocks publication, and retry
  // starts a visibly separate attempt.
  await interruptTurnFenced(pool, full, pick, input.assistantTurnId, attemptId);
  return "applied";
}

/**
 * Worker-owned generation for one assistant turn: fenced claim -> fresh
 * permit + S01 dispatch -> fenced publish. Crash between phases leaves PG
 * truth resumable: the next delivery reclaims with a new generation, marks
 * the dead attempt interrupted, and publishes at most once.
 */
export async function processChatJob(
  pool: Pool,
  backgroundJobId: string,
  transport: DispatchTransport | null,
  opts?: { workerId?: string; leaseMs?: number; bullmqJobId?: string },
): Promise<ChatOutcome> {
  const claimed = await claimChatGeneration(pool, backgroundJobId, opts);
  if (!claimed) return "duplicate-terminal-noop";
  return driveChatGeneration(pool, claimed, transport);
}

/** Cancel the S01 reservation behind an attempt (best effort; publish stays fenced). */
export async function cancelAttemptReservation(pool: Pool, claims: TenantClaims, attemptId: string): Promise<void> {
  if (!isUuid(attemptId)) return;
  await withTenant(pool, claims, async (client) => {
    const found = await client.query("SELECT reservation_id FROM chat_attempts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, attemptId]);
    const reservationId = (found.rows[0] as { reservation_id: string | null } | undefined)?.reservation_id;
    if (!reservationId) return;
    try {
      await cancelDispatch(pool, claims, reservationId);
    } catch {
      // Reservation already settled or foreign: publish fencing owns the
      // outcome; a failed cancel here must not fail the turn cancel.
    }
  });
}
