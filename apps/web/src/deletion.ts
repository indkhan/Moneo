// E08-S01b durable deletion (architecture ##461-464; product R1 privacy row;
// founder decision 2026-09-24: deleting an identity preserves shared
// workspace finance for remaining members while removing the departed
// member's membership, sessions and personal content).
//
// Two scopes, one coordinator:
// - workspace: an owner purges the whole workspace for every member.
// - identity: a member removes themselves from one workspace and purges
//   their personal content there (threads, notices, grants, exports,
//   sessions, membership). Shared finance/audit rows stay; once-identifying
//   actor UUIDs dangle unlinkably after the users row is anonymized.
//   A sole owner must name an existing-member successor (atomic handoff); a
//   sole member purges the workspace instead.
//
// Ordering per request: step-up + ownership checks, cancel queued effects,
// set workspaces.deletion_requested_at (immediate revocation: withTenant
// denies flagged workspaces at every boundary), then resumable
// bounded-batch purge with per-table checkpoints, object deletes, session
// revocation, membership changes, tombstone and COMPLETE. Repeat requests
// with one idempotency key resume to a single completion record; partial
// object/processor failure stays FAILED (visible, retryable), never COMPLETE.
//
// Privileged path (explicit, reviewer-owned): after revocation the
// coordinator can no longer pass withTenant, so it runs in
// withDeletionWorkspace — RLS workspace settings still apply, and entry
// requires an authorized PENDING/IN_PROGRESS/FAILED deletion request for
// that workspace. Membership cross-checks for identity finalization read
// only the deletion subject's own rows. No other module may use it.
//
// External identity deletion (Keycloak admin) is deployment-wired: the
// default is a recording stand-in and the deployed replacement is an open
// gate (S02/S04). Processor deletion records none-configured locally.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantDenied, TenantInvalid, listWorkspaces, withTenant, type TenantClaims } from "./tenancy.ts";
import { cancelJob } from "./job-recovery.ts";
import { closeArtifactSession } from "./artifact-host.ts";
import { s3Delete, s3DeleteExport, type S3Config } from "./s3.ts";
import { ExportError, assertFreshStepUp } from "./export.ts";
import type { Session } from "./session-store.ts";

export const DELETIONS_REQUEST = "deletions.request";
export const DELETION_BATCH_ROWS = 1000;
const REPLAY_RETENTION_DAYS = 30;

export type DeletionScope = "workspace" | "identity";
export type DeletionStatus = "PENDING" | "IN_PROGRESS" | "COMPLETE" | "FAILED";

export type DeletionView = {
  workspaceId: string;
  id: string;
  scope: DeletionScope;
  subjectUserId: string;
  requestedBy: string;
  successorUserId: string | null;
  status: DeletionStatus;
  checkpoint: Record<string, unknown>;
  errorCode: string | null;
  completedAt: string | null;
};

export class DeletionError extends Error {
  readonly code:
    | "not_found"
    | "idempotency_reuse"
    | "idempotency_expired"
    | "step_up_required"
    | "forbidden"
    | "successor_required"
    | "successor_invalid"
    | "object_store_unavailable";
  constructor(code: DeletionError["code"]) {
    super(code);
    this.code = code;
  }
}

export function deletionErrorBody(err: DeletionError): { status: number; body: unknown } {
  if (err.code === "not_found") return { status: 404, body: { error: "not_found" } };
  if (err.code === "step_up_required") return { status: 403, body: { error: "forbidden", reason: "step_up_required" } };
  if (err.code === "forbidden") return { status: 403, body: { error: "forbidden", reason: "deletion_forbidden" } };
  if (err.code === "successor_required" || err.code === "successor_invalid") return { status: 409, body: { error: "conflict", reason: err.code } };
  if (err.code === "object_store_unavailable") return { status: 503, body: { error: "unavailable", reason: err.code } };
  return { status: 409, body: { error: "conflict", reason: err.code } };
}

// ---- External identity hook (deployment-wired Keycloak admin) ----

export type ExternalIdentityDeleter = (keycloakSub: string) => Promise<"deleted" | "not_found">;

let externalDeleter: ExternalIdentityDeleter = async () => "deleted";
let externalDeleteCalls: string[] = [];

/** Replace the stand-in (tests); the deployed Keycloak admin deleter is an open S02/S04 gate. */
export function setExternalIdentityDeleter(fn: ExternalIdentityDeleter): void {
  externalDeleter = fn;
  externalDeleteCalls = [];
}

export function resetExternalIdentityDeleter(): void {
  externalDeleter = async () => "deleted";
  externalDeleteCalls = [];
}

/** Keycloak subs the stand-in was asked to delete (test evidence only; never logged). */
export function externalIdentityDeleteCalls(): string[] {
  return [...externalDeleteCalls];
}

async function deleteExternalIdentity(sub: string): Promise<"deleted" | "not_found"> {
  const result = await externalDeleter(sub);
  externalDeleteCalls.push(sub);
  return result;
}

// ---- Test fault seam (module-level; never HTTP-reachable) ----

let faultAfterTables: number | null = null;

/** Throw after N purged tables to prove checkpoint resume. Tests only. */
export function setDeletionTestFault(n: number | null): void {
  faultAfterTables = n;
}

// ---- Privileged deletion context (see header) ----

async function withDeletionWorkspace<T>(pool: Pool, workspaceId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isUuid(workspaceId)) throw new TenantDenied();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace', $1, true)", [workspaceId]);
    const req = await client.query("SELECT 1 FROM deletion_requests WHERE workspace_id = $1 AND status IN ('PENDING', 'IN_PROGRESS', 'FAILED')", [workspaceId]);
    if ((req.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      throw new TenantDenied();
    }
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch { /* preserve the original error */ }
    throw err;
  } finally {
    client.release();
  }
}

function loadDeletionObjectStore(): S3Config | null {
  const endpoint = process.env["S3_ENDPOINT"];
  const accessKey = process.env["S3_ACCESS_KEY"];
  const secretKey = process.env["S3_SECRET_KEY"];
  const bucket = process.env["S3_BUCKET"];
  if (!endpoint || !accessKey || !secretKey || !bucket) return null;
  return { endpoint, region: process.env["S3_REGION"] ?? "us-east-1", accessKey, secretKey, bucket };
}

// ---- Accept ----

export function validateDeletionAcceptInput(value: unknown): {
  workspaceId: string;
  scope: DeletionScope;
  successorUserId: string | null;
  idempotencyKey: string;
} {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "scope", "successorUserId", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  if (typeof v["workspaceId"] !== "string" || !isUuid(v["workspaceId"] as string)) throw new TenantInvalid();
  if (v["scope"] !== "workspace" && v["scope"] !== "identity") throw new TenantInvalid();
  if (v["successorUserId"] !== undefined && v["successorUserId"] !== null && (typeof v["successorUserId"] !== "string" || !isUuid(v["successorUserId"] as string))) {
    throw new TenantInvalid();
  }
  if (typeof v["idempotencyKey"] !== "string" || !isUuid(v["idempotencyKey"] as string)) throw new TenantInvalid();
  return {
    workspaceId: v["workspaceId"] as string,
    scope: v["scope"] as DeletionScope,
    successorUserId: (v["successorUserId"] as string | null | undefined) ?? null,
    idempotencyKey: v["idempotencyKey"] as string,
  };
}

function acceptRequestHash(input: { workspaceId: string; scope: DeletionScope; successorUserId: string | null }): string {
  return createHash("sha256").update(JSON.stringify({ command: DELETIONS_REQUEST, ...input })).digest("hex");
}

function rowToView(row: {
  workspace_id: string;
  id: string;
  scope: DeletionScope;
  subject_user_id: string;
  requested_by: string;
  successor_user_id: string | null;
  status: DeletionStatus;
  checkpoint: Record<string, unknown>;
  error_code: string | null;
  completed_at: unknown;
}): DeletionView {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    scope: row.scope,
    subjectUserId: row.subject_user_id,
    requestedBy: row.requested_by,
    successorUserId: row.successor_user_id,
    status: row.status,
    checkpoint: row.checkpoint ?? {},
    errorCode: row.error_code,
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : row.completed_at instanceof Date ? row.completed_at.toISOString() : String(row.completed_at),
  };
}

async function readRequest(client: PoolClient, workspaceId: string, requestId: string): Promise<DeletionView | null> {
  const found = await client.query(
    "SELECT workspace_id, id, scope, subject_user_id, requested_by, successor_user_id, status, checkpoint, error_code, completed_at FROM deletion_requests WHERE workspace_id = $1 AND id = $2",
    [workspaceId, requestId],
  );
  if ((found.rowCount ?? 0) === 0) return null;
  return rowToView(found.rows[0] as Parameters<typeof rowToView>[0]);
}

type MemberRow = { user_id: string; role: string };

async function acceptTx(
  client: PoolClient,
  claims: TenantClaims,
  actorId: string,
  session: Session,
  input: ReturnType<typeof validateDeletionAcceptInput>,
): Promise<{ ok: true; requestId: string; replayed: boolean } | { ok: false; code: DeletionError["code"] }> {
  try {
    assertFreshStepUp(session);
  } catch (err) {
    if (err instanceof ExportError && err.code === "step_up_required") return { ok: false, code: "step_up_required" };
    throw err;
  }
  if (process.env["DELETIONS_ENABLED"] !== "1") throw new DeletionError("forbidden");
  const hash = acceptRequestHash({ workspaceId: input.workspaceId, scope: input.scope, successorUserId: input.successorUserId });

  const readOp = async () => {
    const found = await client.query(
      "SELECT id AS \"operationId\", status, request_hash AS \"requestHash\", response_payload AS \"response\", error_payload AS \"error\", expires_at AS \"expiresAt\" FROM command_operations WHERE workspace_id = $1 AND command_name = $2 AND idempotency_key = $3",
      [claims.workspaceId, DELETIONS_REQUEST, input.idempotencyKey],
    );
    return found.rows[0] as { operationId: string; status: string; requestHash: string; response: { requestId: string } | null; error: { code: DeletionError["code"] } | null; expiresAt: string } | undefined;
  };

  const prior = await readOp();
  if (prior) {
    if (new Date(prior.expiresAt).getTime() <= Date.now()) return { ok: false, code: "idempotency_expired" };
    if (prior.requestHash !== hash) return { ok: false, code: "idempotency_reuse" };
    if (prior.status === "SUCCEEDED" && prior.response) return { ok: true, requestId: prior.response.requestId, replayed: true };
    return { ok: false, code: prior.error?.code ?? "idempotency_reuse" };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const operationId = uuidv7();
    await client.query("SAVEPOINT deletions_claim");
    let claimed = false;
    try {
      await client.query(
        "INSERT INTO command_operations (workspace_id, id, command_name, idempotency_key, request_hash, actor_id, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'FAILED_FINAL', now() + ($7 || ' days')::interval)",
        [claims.workspaceId, operationId, DELETIONS_REQUEST, input.idempotencyKey, hash, actorId, String(REPLAY_RETENTION_DAYS)],
      );
      claimed = true;
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      await client.query("ROLLBACK TO SAVEPOINT deletions_claim");
    }
    if (!claimed) {
      let row: Awaited<ReturnType<typeof readOp>>;
      for (let poll = 0; poll < 20; poll++) {
        row = await readOp();
        if (row) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (row) {
        if (new Date(row.expiresAt).getTime() <= Date.now()) return { ok: false, code: "idempotency_expired" };
        if (row.requestHash !== hash) return { ok: false, code: "idempotency_reuse" };
        if (row.status === "SUCCEEDED" && row.response) return { ok: true, requestId: row.response.requestId, replayed: true };
        return { ok: false, code: row.error?.code ?? "idempotency_reuse" };
      }
      continue;
    }

    const fail = async (code: DeletionError["code"]) => {
      await client.query("UPDATE command_operations SET status = 'FAILED_FINAL', error_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
        JSON.stringify({ code }),
        claims.workspaceId,
        operationId,
      ]);
      return { ok: false as const, code };
    };

    // Ownership checks inside the member transaction (withTenant already
    // proved membership; the revocation flag is unset pre-request).
    const members = await client.query("SELECT user_id, role FROM workspace_members WHERE workspace_id = $1", [claims.workspaceId]);
    const rows = members.rows as MemberRow[];
    const mine = rows.find((m) => m.user_id === actorId);
    if (!mine) return fail("forbidden");
    if (input.scope === "workspace" && mine.role !== "owner") return fail("forbidden");

    let successor: string | null = null;
    const soleMember = rows.length === 1 && rows[0]!.user_id === actorId;
    if (input.scope === "identity") {
      const owners = rows.filter((m) => m.role === "owner").map((m) => m.user_id);
      const soleOwner = owners.length === 1 && owners[0] === actorId;
      if (soleOwner && !soleMember) {
        if (!input.successorUserId) return fail("successor_required");
        const next = rows.find((m) => m.user_id === input.successorUserId);
        if (!next || next.user_id === actorId) return fail("successor_invalid");
        successor = next.user_id;
      } else if (input.successorUserId) {
        return fail("successor_invalid");
      }
    } else if (input.successorUserId) {
      return fail("successor_invalid");
    }

    // Server-recorded workspace list for identity finalization (never client input).
    const subRow = await client.query("SELECT auth_subject FROM users WHERE id = $1", [actorId]);
    const authSubject = ((subRow.rows[0] as { auth_subject: string } | undefined)?.auth_subject ?? "");
    const requestId = uuidv7();
    await client.query(
      "INSERT INTO deletion_requests (workspace_id, id, scope, subject_user_id, requested_by, successor_user_id, status, checkpoint) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7)",
      [claims.workspaceId, requestId, input.scope, actorId, actorId, successor, JSON.stringify({ authSubject, acceptedAt: new Date().toISOString() })],
    );
    await client.query("UPDATE command_operations SET status = 'SUCCEEDED', response_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
      JSON.stringify({ requestId }),
      claims.workspaceId,
      operationId,
    ]);
    return { ok: true, requestId, replayed: false };
  }
  throw new Error("command_claim_unsettled");
}

export async function acceptDeletion(
  pool: Pool,
  claims: TenantClaims,
  actorId: string,
  session: Session,
  raw: unknown,
): Promise<{ view: DeletionView; replayed: boolean }> {
  const input = validateDeletionAcceptInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (!isUuid(actorId)) throw new TenantDenied();
  // Resume path first: a retry with the same idempotency key must work even
  // after revocation removed every membership (withTenant would deny). The
  // key is unguessable, the caller holds a valid session, and resume only
  // continues the already-authorized purge — no fresh step-up is demanded,
  // or stranded FAILED requests could never converge.
  const resumedId = await withDeletionWorkspace(pool, claims.workspaceId, async (client) => {
    const found = await client.query(
      "SELECT status, request_hash AS \"requestHash\", response_payload AS \"response\", error_payload AS \"error\", expires_at AS \"expiresAt\" FROM command_operations WHERE workspace_id = $1 AND command_name = $2 AND idempotency_key = $3",
      [claims.workspaceId, DELETIONS_REQUEST, input.idempotencyKey],
    );
    if ((found.rowCount ?? 0) === 0) return null;
    const row = found.rows[0] as { status: string; requestHash: string; response: { requestId: string } | null; error: { code: DeletionError["code"] } | null; expiresAt: string };
    const hash = acceptRequestHash({ workspaceId: input.workspaceId, scope: input.scope, successorUserId: input.successorUserId });
    if (new Date(row.expiresAt).getTime() <= Date.now()) throw new DeletionError("idempotency_expired");
    if (row.requestHash !== hash) throw new DeletionError("idempotency_reuse");
    if (row.status === "SUCCEEDED" && row.response) return row.response.requestId as string;
    throw new DeletionError(row.error?.code ?? "idempotency_reuse");
  }).catch((err) => {
    if (err instanceof TenantDenied) return null;
    throw err;
  });
  if (resumedId) {
    const view = await runDeletion(pool, claims.workspaceId, resumedId);
    return { view, replayed: true };
  }
  // Fresh path: membership, ownership and step-up gates apply.
  const decided = await withTenant(pool, claims, (client) => acceptTx(client, claims, actorId, session, input));
  if (!decided.ok) throw new DeletionError(decided.code);
  const view = await runDeletion(pool, claims.workspaceId, decided.requestId);
  return { view, replayed: false };
}

export async function readDeletion(pool: Pool, claims: TenantClaims, requestId: string): Promise<DeletionView | null> {
  if (!isUuid(requestId)) return null;
  return withTenant(pool, claims, async (client) => readRequest(client, claims.workspaceId, requestId)).catch((err) => {
    if (err instanceof TenantDenied) return null;
    throw err;
  });
}

/** Workspace members for the successor picker (ids + roles only, no identity material). */
export async function listDeletionMembers(pool: Pool, claims: TenantClaims): Promise<MemberRow[]> {
  return withTenant(pool, claims, async (client) => {
    const found = await client.query("SELECT user_id, role FROM workspace_members WHERE workspace_id = $1 ORDER BY role DESC, user_id", [claims.workspaceId]);
    return found.rows as MemberRow[];
  }).catch((err) => {
    if (err instanceof TenantDenied) return [];
    throw err;
  });
}

// ---- Coordinator ----

// Workspace-scope purge order: children before parents (composite FKs have
// no cascade). CASCADE on workspace_id FKs is the backstop, not the plan:
// every table completion is a checkpoint so resume skips finished work.
const WORKSPACE_PURGE_TABLES = [
  "notices",
  "home_layout_tiles",
  "home_layouts",
  "deep_analysis_findings",
  "deep_analysis_steps",
  "deep_analysis_runs",
  "artifact_ai_proposals",
  "artifact_state_snapshots",
  "artifact_state_migrations",
  "artifact_state",
  "artifact_sdk_access_events",
  "artifact_runtime_grants",
  "artifact_build_attempts",
  "artifact_versions",
  "chat_tool_calls",
  "chat_attempts",
  "chat_activity",
  "chat_turns",
  "ai_action_proposals",
  "ai_eval_runs",
  "ai_eval_summaries",
  "ai_eval_cases",
  "ai_dispatch_usage",
  "ai_dispatch_reservations",
  "background_job_attempts",
  "review_decisions",
  "source_links",
  "transaction_tags",
  "import_commit_batches",
  "mapping_provider_usage",
  "mapping_provider_reservations",
  "mapping_proposals",
  "mapping_profiles",
  "parsed_observations",
  "source_objects",
  "balance_audit",
  "manual_transactions",
  "transactions",
  "fx_valuation",
  "fx_rates_manual",
  "fx_rates_ecb",
  "balance_snapshots",
  "imports",
  "data_sources",
  "export_packages",
  "outbox_events",
  "background_job_results",
  "background_jobs",
  "job_dispatch_index",
  "command_operations",
  "ai_dispatch_permits",
  "ai_exclusions",
  "ai_policies",
  "ai_dispatch_budgets",
  "projection_events",
  "projection_points",
  "projection_runs",
  "projection_settings",
  "financial_assumptions",
  "recurring_overrides",
  "scenario_overrides",
  "scenarios",
  "goal_allocations",
  "goals",
  "artifacts",
  "chat_threads",
  "categories",
  "tags",
  "audit_events",
  "accounts",
  "calculation_versions",
  "workspace_data_revision",
];

async function deleteTableBatched(client: PoolClient, table: string, workspaceId: string, extra = "", extraParams: unknown[] = []): Promise<number> {
  let total = 0;
  for (;;) {
    const found = await client.query(`DELETE FROM ${table} WHERE ctid = ANY (SELECT ctid FROM ${table} WHERE workspace_id = $1 ${extra} LIMIT ${DELETION_BATCH_ROWS})`, [
      workspaceId,
      ...extraParams,
    ]);
    total += found.rowCount ?? 0;
    if ((found.rowCount ?? 0) === 0) return total;
    if (total > 50_000_000) throw new Error("deletion bound exceeded");
  }
}

async function checkpointDone(client: PoolClient, workspaceId: string, requestId: string, table: string): Promise<void> {
  await client.query(
    "UPDATE deletion_requests SET checkpoint = checkpoint || jsonb_build_object('done', coalesce(checkpoint->'done', '[]'::jsonb) || to_jsonb($3::text)) WHERE workspace_id = $1 AND id = $2",
    [workspaceId, requestId, table],
  );
}

function checkpointTables(checkpoint: Record<string, unknown>): Set<string> {
  const done = (checkpoint as { done?: unknown }).done;
  return new Set(Array.isArray(done) ? done.filter((t): t is string => typeof t === "string") : []);
}

async function failRequest(pool: Pool, workspaceId: string, requestId: string, code: string): Promise<DeletionView> {
  return withDeletionWorkspace(pool, workspaceId, async (client) => {
    await client.query("UPDATE deletion_requests SET status = 'FAILED', error_code = $3, completed_at = now() WHERE workspace_id = $1 AND id = $2", [
      workspaceId,
      requestId,
      code,
    ]);
    const view = await readRequest(client, workspaceId, requestId);
    if (!view) throw new TenantDenied();
    return view;
  });
}

async function purgeSourceObjects(client: PoolClient, s3: S3Config, workspaceId: string): Promise<number> {
  let total = 0;
  for (;;) {
    const keys = await client.query("SELECT object_key FROM source_objects WHERE workspace_id = $1 LIMIT $2", [workspaceId, DELETION_BATCH_ROWS]);
    if ((keys.rowCount ?? 0) === 0) return total;
    for (const row of keys.rows as Array<{ object_key: string }>) {
      await s3Delete(s3, row.object_key);
    }
    await client.query("DELETE FROM source_objects WHERE workspace_id = $1 AND object_key = ANY ($2)", [workspaceId, (keys.rows as Array<{ object_key: string }>).map((r) => r.object_key)]);
    total += keys.rowCount ?? 0;
  }
}

async function purgeExportPackages(client: PoolClient, s3: S3Config, workspaceId: string, onlyRequestedBy: string | null): Promise<number> {
  const extra = onlyRequestedBy === null ? "" : "AND requested_by = $2";
  const params = onlyRequestedBy === null ? [] : [onlyRequestedBy];
  for (;;) {
    const rows = await client.query(`SELECT id, object_key FROM export_packages WHERE workspace_id = $1 ${extra} LIMIT ${DELETION_BATCH_ROWS}`, [workspaceId, ...params]);
    if ((rows.rowCount ?? 0) === 0) return 0;
    for (const row of rows.rows as Array<{ id: string; object_key: string | null }>) {
      if (row.object_key) await s3DeleteExport(s3, row.object_key);
    }
    await client.query(`DELETE FROM export_packages WHERE workspace_id = $1 AND id = ANY ($2)`, [workspaceId, (rows.rows as Array<{ id: string }>).map((r) => r.id)]);
  }
}

async function revokeSessions(pool: Pool, subs: string[]): Promise<void> {
  for (const sub of subs) {
    if (typeof sub !== "string" || sub.length === 0 || sub.length > 500) continue;
    await pool.query("UPDATE app_sessions SET revoked_at = now() WHERE keycloak_sub = $1 AND revoked_at IS NULL", [sub]);
  }
}

function userSubs(client: PoolClient, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return Promise.resolve([]);
  return client.query("SELECT auth_subject FROM users WHERE id = ANY ($1)", [userIds]).then((r) => (r.rows as Array<{ auth_subject: string }>).map((row) => row.auth_subject));
}

/**
 * Synchronous coordinator: cancel queued effects, revoke, purge with
 * checkpoints, tombstone, finalize. Idempotent per request id; resume skips
 * checkpointed tables. Returns the terminal view (COMPLETE or FAILED).
 */
export async function runDeletion(pool: Pool, workspaceId: string, requestId: string): Promise<DeletionView> {
  const loaded = await withDeletionWorkspace(pool, workspaceId, (client) => readRequest(client, workspaceId, requestId));
  if (!loaded) throw new TenantDenied();
  // COMPLETE is terminal for data, but identity finalization (external +
  // anonymize) runs after the final transaction: re-run it idempotently so
  // a crash in that window still converges.
  if (loaded.status === "COMPLETE") {
    await finalizeIdentity(pool, loaded.subjectUserId).catch(() => null);
    return loaded;
  }
  const scope = loaded.scope;
  const subject = loaded.subjectUserId;

  // Cancel queued effects BEFORE revocation (cancelJob needs member
  // context). On resume past revocation the flag is set and no new jobs can
  // exist (every accept path passes withTenant), so the cancel reruns only
  // while unrevoked.
  const revokedAlready = await withDeletionWorkspace(pool, workspaceId, async (client) => {
    const head = await readRequest(client, workspaceId, requestId);
    return head ? checkpointTables(head.checkpoint).has("__revoked") : false;
  }).catch(() => false);
  if (!revokedAlready) {
    try {
      if (scope === "workspace") {
        const jobs = await withTenant(pool, { userId: loaded.requestedBy, workspaceId }, async (client) => {
          const found = await client.query("SELECT id FROM background_jobs WHERE workspace_id = $1 AND status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED')", [workspaceId]);
          return (found.rows as Array<{ id: string }>).map((r) => r.id);
        });
        for (const jobId of jobs) {
          await cancelJob(pool, { userId: loaded.requestedBy, workspaceId }, jobId).catch(() => null);
        }
      } else {
        // accepted_by lives on the ID-only dispatch index (jobs carry no
        // actor column); join it under tenancy like every other read.
        const jobs = await withTenant(pool, { userId: subject, workspaceId }, async (client) => {
          const found = await client.query(
            "SELECT j.id FROM background_jobs j JOIN job_dispatch_index d ON d.workspace_id = j.workspace_id AND d.job_id = j.id WHERE j.workspace_id = $1 AND d.accepted_by = $2 AND j.status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED')",
            [workspaceId, subject],
          );
          return (found.rows as Array<{ id: string }>).map((r) => r.id);
        });
        for (const jobId of jobs) {
          await cancelJob(pool, { userId: subject, workspaceId }, jobId).catch(() => null);
        }
      }
    } catch (err) {
      if (err instanceof TenantDenied) return failRequest(pool, workspaceId, requestId, "forbidden");
      throw err;
    }
  }

  // Every step below is its own deletion-context transaction: checkpoints
  // commit incrementally, so resume after process death skips finished work.
  // Final steps are single atomic transactions (tombstone + COMPLETE +
  // workspace-row delete), so no resume can observe a half-final state.
  const readDone = async (): Promise<Set<string>> => {
    const head = await withDeletionWorkspace(pool, workspaceId, (client) => readRequest(client, workspaceId, requestId));
    if (!head) throw new TenantDenied();
    return checkpointTables(head.checkpoint);
  };
  const markDone = async (table: string): Promise<void> => {
    await withDeletionWorkspace(pool, workspaceId, (client) => checkpointDone(client, workspaceId, requestId, table));
  };
  let stepsDone = (await readDone()).size;
  const faultCheck = (): void => {
    stepsDone += 1;
    if (faultAfterTables !== null && stepsDone >= faultAfterTables) throw new Error("deletion_fault_injected");
  };

  const s3 = loadDeletionObjectStore();
  const needObjects = (): S3Config => {
    if (!s3) throw new DeletionError("object_store_unavailable");
    return s3;
  };

  const purgeWorkspaceTables = async (onlyRequestedBy: string | null): Promise<void> => {
    const done = await readDone();
    for (const table of WORKSPACE_PURGE_TABLES) {
      if (done.has(table)) continue;
      await withDeletionWorkspace(pool, workspaceId, async (client) => {
        if (table === "source_objects") {
          await purgeSourceObjects(client, needObjects(), workspaceId);
        } else if (table === "export_packages") {
          await purgeExportPackages(client, needObjects(), workspaceId, onlyRequestedBy);
        } else {
          await deleteTableBatched(client, table, workspaceId);
        }
        await checkpointDone(client, workspaceId, requestId, table);
      });
      done.add(table);
      faultCheck();
    }
  };

  const closeGrantSessions = async (userId: string | null): Promise<void> => {
    const ids = await withDeletionWorkspace(pool, workspaceId, async (client) => {
      const found =
        userId === null
          ? await client.query("SELECT session_id FROM artifact_runtime_grants WHERE workspace_id = $1", [workspaceId])
          : await client.query("SELECT session_id FROM artifact_runtime_grants WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]);
      return (found.rows as Array<{ session_id: string }>).map((r) => r.session_id);
    }).catch(() => []);
    for (const sessionId of ids) {
      try {
        closeArtifactSession(sessionId);
      } catch { /* best effort; rows are gone regardless */ }
    }
  };

  try {
    await withDeletionWorkspace(pool, workspaceId, async (client) => {
      await client.query("UPDATE deletion_requests SET status = 'IN_PROGRESS' WHERE workspace_id = $1 AND id = $2 AND status <> 'COMPLETE'", [workspaceId, requestId]);
    });

    const shape = await withDeletionWorkspace(pool, workspaceId, async (client) => {
      const members = (await client.query("SELECT user_id, role FROM workspace_members WHERE workspace_id = $1", [workspaceId])).rows as MemberRow[];
      const req = await readRequest(client, workspaceId, requestId);
      if (!req) throw new TenantDenied();
      return { members, successor: req.successorUserId };
    });
    const isMember = shape.members.some((m) => m.user_id === subject);
    const others = shape.members.filter((m) => m.user_id !== subject);
    const soleMember = isMember && others.length === 0;
    const soleOwner = shape.members.filter((m) => m.role === "owner").length === 1 && shape.members.some((m) => m.user_id === subject && m.role === "owner");
    const purgeWholeWorkspace = scope === "workspace" || soleMember;

    if (purgeWholeWorkspace) {
      // Immediate revocation precedes the purge (workspace scope only; the
      // sole-member identity case revokes the same way — nobody remains).
      if (!(await readDone()).has("__revoked")) {
        await withDeletionWorkspace(pool, workspaceId, async (client) => {
          await client.query("UPDATE workspaces SET deletion_requested_at = now() WHERE id = $1 AND deletion_requested_at IS NULL", [workspaceId]);
          await checkpointDone(client, workspaceId, requestId, "__revoked");
        });
        faultCheck();
      }
      await closeGrantSessions(null);
      await purgeWorkspaceTables(null);
      const memberSubs = await withDeletionWorkspace(pool, workspaceId, async (client) =>
        userSubs(client, (await client.query("SELECT user_id FROM workspace_members WHERE workspace_id = $1", [workspaceId])).rows.map((r: { user_id: string }) => r.user_id)),
      );
      // Atomic final step: tombstone + COMPLETE + workspace-row delete
      // (cascade removes members and this request row).
      const view = await withDeletionWorkspace(pool, workspaceId, async (client) => {
        await client.query("INSERT INTO deletion_tombstones (id, subject_kind, subject_ref, workspace_ref, scope, request_id, basis) VALUES ($1, $2, $3, $3, $4, $5, 'erasure-request') ON CONFLICT (request_id) DO NOTHING", [
          uuidv7(),
          scope === "workspace" ? "workspace" : "identity",
          scope === "workspace" ? workspaceId : subject,
          scope,
          requestId,
        ]);
        await client.query("UPDATE deletion_requests SET status = 'COMPLETE', completed_at = now() WHERE workspace_id = $1 AND id = $2", [workspaceId, requestId]);
        const completed = await readRequest(client, workspaceId, requestId);
        await client.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
        return completed;
      });
      if (!view) throw new TenantDenied();
      await revokeSessions(pool, memberSubs);
      if (scope === "identity") await finalizeIdentity(pool, subject);
      return view;
    }

    // Shared-workspace identity removal.
    if (isMember && soleOwner && others.length > 0) {
      const successor = shape.successor;
      if (!successor || !others.some((m) => m.user_id === successor)) {
        return failRequest(pool, workspaceId, requestId, "successor_invalid");
      }
      // Atomic handoff: successor becomes owner as the subject leaves.
      await withDeletionWorkspace(pool, workspaceId, async (client) => {
        await client.query("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2", [workspaceId, successor]);
      });
    }

    // Personal content purge (bounded batches, checkpointed steps).
    const personalTables: Array<{ table: string; extra: string; params: unknown[] }> = [
      { table: "notices", extra: "AND user_id = $2", params: [subject] },
      { table: "chat_activity", extra: "AND thread_id IN (SELECT id FROM chat_threads WHERE workspace_id = $1 AND created_by = $2)", params: [subject] },
      { table: "chat_tool_calls", extra: "AND attempt_id IN (SELECT a.id FROM chat_attempts a JOIN chat_turns t ON t.workspace_id = a.workspace_id AND t.id = a.turn_id JOIN chat_threads th ON th.workspace_id = a.workspace_id AND th.id = t.thread_id WHERE a.workspace_id = $1 AND th.created_by = $2)", params: [subject] },
      { table: "chat_attempts", extra: "AND turn_id IN (SELECT t.id FROM chat_turns t JOIN chat_threads th ON th.workspace_id = t.workspace_id AND th.id = t.thread_id WHERE t.workspace_id = $1 AND th.created_by = $2)", params: [subject] },
      { table: "chat_turns", extra: "AND thread_id IN (SELECT id FROM chat_threads WHERE workspace_id = $1 AND created_by = $2)", params: [subject] },
      { table: "chat_threads", extra: "AND created_by = $2", params: [subject] },
      { table: "ai_action_proposals", extra: "AND (proposed_by = $2 OR confirmed_by = $2)", params: [subject] },
      { table: "artifact_runtime_grants", extra: "AND user_id = $2", params: [subject] },
    ];
    for (const step of personalTables) {
      const key = `personal:${step.table}`;
      if ((await readDone()).has(key)) continue;
      await withDeletionWorkspace(pool, workspaceId, async (client) => {
        await deleteTableBatched(client, step.table, workspaceId, step.extra, step.params);
        await checkpointDone(client, workspaceId, requestId, key);
      });
      faultCheck();
    }
    if (!(await readDone()).has("personal:exports")) {
      await withDeletionWorkspace(pool, workspaceId, async (client) => {
        await purgeExportPackages(client, needObjects(), workspaceId, subject);
        await checkpointDone(client, workspaceId, requestId, "personal:exports");
      });
      faultCheck();
    }
    await closeGrantSessions(subject);
    const subjectSubs = await withDeletionWorkspace(pool, workspaceId, (client) => userSubs(client, [subject]));
    await revokeSessions(pool, subjectSubs);
    // Atomic final step: membership removal + tombstone + COMPLETE.
    const view = await withDeletionWorkspace(pool, workspaceId, async (client) => {
      await client.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, subject]);
      await client.query("INSERT INTO deletion_tombstones (id, subject_kind, subject_ref, workspace_ref, scope, request_id, basis) VALUES ($1, 'identity', $2, $3, 'identity', $4, 'erasure-request') ON CONFLICT (request_id) DO NOTHING", [
        uuidv7(),
        subject,
        workspaceId,
        requestId,
      ]);
      await client.query("UPDATE deletion_requests SET status = 'COMPLETE', completed_at = now() WHERE workspace_id = $1 AND id = $2", [workspaceId, requestId]);
      return readRequest(client, workspaceId, requestId);
    });
    if (!view) throw new TenantDenied();
    await finalizeIdentity(pool, subject);
    return view;
  } catch (err) {
    if (err instanceof TenantDenied) throw err;
    if (err instanceof DeletionError && err.code === "object_store_unavailable") {
      return failRequest(pool, workspaceId, requestId, "object_store_unavailable");
    }
    if ((err as Error).message === "deletion_fault_injected") {
      return failRequest(pool, workspaceId, requestId, "fault_injected");
    }
    throw err;
  }
}

/**
 * Identity finalization: once the subject holds no membership anywhere,
 * delete the external Keycloak identity (idempotent) and anonymize the
 * users row so retained financial provenance can no longer relink the
 * departed identity. Multi-workspace subjects finalize on the request that
 * removes their last membership; the checkpoint records the deferral.
 */
async function finalizeIdentity(pool: Pool, subjectUserId: string): Promise<void> {
  const subRow = await pool.query("SELECT auth_subject FROM users WHERE id = $1", [subjectUserId]);
  if ((subRow.rowCount ?? 0) === 0) return;
  const sub = (subRow.rows[0] as { auth_subject: string }).auth_subject;
  if (sub.startsWith("deleted:")) return;
  // Cross-workspace membership check without a bypass: users is the
  // identity anchor (no RLS); workspace_members is read once per
  // server-known workspace inside that workspace's own RLS setting, and
  // only the deletion subject's row is ever inspected.
  const wsList = await listWorkspaces(pool, sub).catch(() => []);
  for (const ws of wsList as Array<{ id: string }>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace', $1, true)", [ws.id]);
      const found = await client.query("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [ws.id, subjectUserId]);
      await client.query("ROLLBACK");
      if ((found.rowCount ?? 0) > 0) return;
    } catch {
      try {
        await client.query("ROLLBACK");
      } catch { /* ignore */ }
      return;
    } finally {
      client.release();
    }
  }
  await deleteExternalIdentity(sub);
  await pool.query("UPDATE users SET auth_subject = $2 WHERE id = $1 AND auth_subject = $3", [subjectUserId, `deleted:${uuidv7()}`, sub]);
}

/** Tombstones visible to the S02 restore replay (UUIDs/codes only). */
export async function listTombstones(pool: Pool): Promise<Array<{ subjectKind: string; subjectRef: string; workspaceRef: string | null; scope: string; requestId: string; deletedAt: string }>> {
  const found = await pool.query("SELECT subject_kind AS \"subjectKind\", subject_ref AS \"subjectRef\", workspace_ref AS \"workspaceRef\", scope, request_id AS \"requestId\", deleted_at AS \"deletedAt\" FROM deletion_tombstones ORDER BY deleted_at, id");
  return (found.rows as Array<{ subjectKind: string; subjectRef: string; workspaceRef: string | null; scope: string; requestId: string; deletedAt: Date }>).map((r) => ({
    subjectKind: r.subjectKind,
    subjectRef: String(r.subjectRef),
    workspaceRef: r.workspaceRef === null ? null : String(r.workspaceRef),
    scope: r.scope,
    requestId: String(r.requestId),
    deletedAt: (r.deletedAt as Date).toISOString(),
  }));
}
