// E08-S01 workspace export (architecture ##458-460; product R1 privacy row).
// A workspace owner with a fresh verified step-up obtains a private,
// machine-readable package: UTF-8 CSV finance data plus versioned JSON for
// accounts, source observations, goals, artifacts/source/state, saved
// analyses, the requesting user's own conversations and attributable
// activity, with manifest, currency/date conventions and per-section counts.
// Other members' private conversations/activity and all secrets are excluded
// even when the requester owns the workspace.
//
// Durability reuses the E02 job/outbox/fencing machinery: accept writes
// command_operations + background_jobs + outbox_events + job_dispatch_index
// + export_packages(BUILDING) in ONE tenant transaction; the worker claims a
// fenced generation, snapshots every section in one REPEATABLE READ
// transaction (never spanning the object upload), encrypts with a
// per-package AES-256-GCM data key (ciphertext only in the object store, key
// only in the RLS-protected row), PUTs under a generated exports/ key and
// publishes READY fenced. Retry overwrites the same key: at most one current
// private package per idempotency key. Download is one-use, auth-checked and
// audited; 24h expiry removes the object (lazy on access plus an explicit
// member sweep; the scheduled cross-workspace sweep is S01c-owned).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";
import { resolveJobRoute, type JobRoute } from "./jobs.ts";
import {
  DEFAULT_RUNTIME_LEASE_MS,
  RecoveryError,
  cancelJob,
  checkpointAttempt,
  claimAttempt,
  fencedGuard,
  markAttempt,
  validateLeaseMs,
  validateWorkerId,
  type Claim,
} from "./job-recovery.ts";
import { exportKey, s3DeleteExport, s3GetExport, s3PutExport, type S3Config } from "./s3.ts";
import type { Session } from "./session-store.ts";

export const EXPORTS_BUILD = "exports.build";
export const EXPORT_FORMAT = "moneo-export/1";
export const EXPORT_EXPIRY_HOURS = 24;
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;
export const MAX_ACTIVE_EXPORTS = 1;
export const MAX_EXPORT_ROWS = 100_000;
export const MAX_EXPORT_OBJECT_BYTES = 64 * 1024 * 1024;
const REPLAY_RETENTION_DAYS = 30;

export type ExportStatus = "BUILDING" | "READY" | "FAILED_FINAL" | "EXPIRED";

export type ExportView = {
  workspaceId: string;
  id: string;
  jobId: string;
  status: ExportStatus;
  cutoff: string;
  expiresAt: string;
  downloadedAt: string | null;
  sectionCounts: Record<string, number> | null;
  manifest: Record<string, unknown> | null;
  errorCode: string | null;
};

export type ExportAcceptResult = { view: ExportView; operationId: string; packageId: string; jobId: string; replayed: boolean };

export class ExportError extends Error {
  readonly code: "not_found" | "idempotency_reuse" | "idempotency_expired" | "workspace_busy" | "step_up_required" | "too_large";
  constructor(code: ExportError["code"]) {
    super(code);
    this.code = code;
  }
}

export function exportErrorBody(err: ExportError): { status: number; body: unknown } {
  if (err.code === "not_found") return { status: 404, body: { error: "not_found" } };
  if (err.code === "step_up_required") return { status: 403, body: { error: "forbidden", reason: "step_up_required" } };
  if (err.code === "too_large") return { status: 413, body: { error: "payload_too_large", reason: "export_too_large" } };
  return { status: 409, body: { error: "conflict", reason: err.code } };
}

export type ExportConfig = { s3: S3Config };

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`E08-S01 exports disabled: missing ${name} (no secret value logged).`);
  return value;
}

/** Fail-closed loader: export creation/download stay disabled unless explicitly enabled with object storage. */
export function loadExportConfig(): ExportConfig {
  if (process.env["EXPORTS_ENABLED"] !== "1") throw new Error("E08-S01 exports disabled: set EXPORTS_ENABLED=1 with S3 configuration.");
  return {
    s3: {
      endpoint: requiredEnv("S3_ENDPOINT"),
      region: process.env["S3_REGION"] ?? "us-east-1",
      accessKey: requiredEnv("S3_ACCESS_KEY"),
      secretKey: requiredEnv("S3_SECRET_KEY"),
      bucket: requiredEnv("S3_BUCKET"),
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateExportAcceptInput(value: unknown): { workspaceId: string; idempotencyKey: string } {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  if (typeof v["workspaceId"] !== "string" || !UUID_RE.test(v["workspaceId"] as string)) throw new TenantInvalid();
  if (typeof v["idempotencyKey"] !== "string" || !UUID_RE.test(v["idempotencyKey"] as string)) throw new TenantInvalid();
  return { workspaceId: v["workspaceId"] as string, idempotencyKey: v["idempotencyKey"] as string };
}

function acceptRequestHash(workspaceId: string): string {
  return createHash("sha256").update(JSON.stringify({ command: EXPORTS_BUILD, workspaceId })).digest("hex");
}

/** Fresh verified step-up required: server-recorded instant within 5 minutes (never future beyond skew) plus a recorded provider acr. Missing either fails closed. */
export function assertFreshStepUp(session: Session): void {
  const stepUpAt = session.stepUpAt;
  if (!stepUpAt || !session.stepUpAcr) throw new ExportError("step_up_required");
  const at = new Date(stepUpAt).getTime();
  if (!Number.isFinite(at)) throw new ExportError("step_up_required");
  const now = Date.now();
  if (at > now + 60_000 || now - at > STEP_UP_WINDOW_MS) throw new ExportError("step_up_required");
}

function rowToView(row: {
  workspace_id: string;
  id: string;
  job_id: string;
  status: ExportStatus;
  cutoff: unknown;
  expires_at: unknown;
  downloaded_at: unknown;
  section_counts: Record<string, number> | null;
  manifest: Record<string, unknown> | null;
  error_code: string | null;
}): ExportView {
  const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    jobId: row.job_id,
    status: row.status,
    cutoff: iso(row.cutoff),
    expiresAt: iso(row.expires_at),
    downloadedAt: row.downloaded_at === null || row.downloaded_at === undefined ? null : iso(row.downloaded_at),
    sectionCounts: row.section_counts,
    manifest: row.manifest,
    errorCode: row.error_code,
  };
}

type StoredOp = {
  operationId: string;
  status: string;
  requestHash: string;
  response: unknown;
  error: { code: ExportError["code"] } | null;
  expiresAt: string;
};

type TxOutcome = { ok: true; result: ExportAcceptResult } | { ok: false; code: ExportError["code"] };

async function readPackageByJob(client: PoolClient, workspaceId: string, jobId: string): Promise<ExportView | null> {
  const found = await client.query(
    "SELECT workspace_id, id, job_id, status, cutoff, expires_at, downloaded_at, section_counts, manifest, error_code FROM export_packages WHERE workspace_id = $1 AND job_id = $2",
    [workspaceId, jobId],
  );
  if ((found.rowCount ?? 0) === 0) return null;
  return rowToView(found.rows[0] as Parameters<typeof rowToView>[0]);
}

async function acceptTx(
  client: PoolClient,
  claims: TenantClaims,
  actorId: string,
  session: Session,
  input: { workspaceId: string; idempotencyKey: string },
): Promise<TxOutcome> {
  assertFreshStepUp(session);
  const hash = acceptRequestHash(input.workspaceId);
  const dedup = `${EXPORTS_BUILD}:${input.idempotencyKey}`;

  const readOp = async (): Promise<StoredOp | undefined> => {
    const found = await client.query(
      "SELECT id AS \"operationId\", status, request_hash AS \"requestHash\", response_payload AS \"response\", error_payload AS \"error\", expires_at AS \"expiresAt\" FROM command_operations WHERE workspace_id = $1 AND command_name = $2 AND idempotency_key = $3",
      [claims.workspaceId, EXPORTS_BUILD, input.idempotencyKey],
    );
    return found.rows[0] as StoredOp | undefined;
  };

  const settle = async (row: StoredOp): Promise<TxOutcome> => {
    if (new Date(row.expiresAt).getTime() <= Date.now()) return { ok: false, code: "idempotency_expired" };
    if (row.requestHash !== hash) return { ok: false, code: "idempotency_reuse" };
    if (row.status === "SUCCEEDED") {
      const resumed = row.response as { packageId: string; jobId: string } | null;
      const view = resumed ? await readPackageByJob(client, claims.workspaceId, resumed.jobId) : null;
      if (!view) return { ok: false, code: "not_found" };
      return { ok: true, result: { view, operationId: row.operationId, packageId: view.id, jobId: view.jobId, replayed: true } };
    }
    return { ok: false, code: row.error?.code ?? "idempotency_reuse" };
  };

  const prior = await readOp();
  if (prior) return settle(prior);

  for (let attempt = 0; attempt < 3; attempt++) {
    const operationId = uuidv7();
    await client.query("SAVEPOINT exports_claim");
    let claimed = false;
    try {
      await client.query(
        "INSERT INTO command_operations (workspace_id, id, command_name, idempotency_key, request_hash, actor_id, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'FAILED_FINAL', now() + ($7 || ' days')::interval)",
        [claims.workspaceId, operationId, EXPORTS_BUILD, input.idempotencyKey, hash, actorId, String(REPLAY_RETENTION_DAYS)],
      );
      claimed = true;
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      await client.query("ROLLBACK TO SAVEPOINT exports_claim");
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

    const fail = async (code: ExportError["code"]): Promise<TxOutcome> => {
      await client.query("UPDATE command_operations SET status = 'FAILED_FINAL', error_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
        JSON.stringify({ code }),
        claims.workspaceId,
        operationId,
      ]);
      return { ok: false, code };
    };

    // One active export per workspace: packages concentrate the whole
    // workspace and are expensive; a second request waits for the first.
    const active = await client.query(
      "SELECT count(*)::int AS n FROM background_jobs WHERE workspace_id = $1 AND job_type = 'exports.build' AND status IN ('QUEUED', 'RUNNING')",
      [claims.workspaceId],
    );
    if ((active.rows[0] as { n: number }).n >= MAX_ACTIVE_EXPORTS) return fail("workspace_busy");

    const jobId = uuidv7();
    const packageId = uuidv7();
    const outboxId = uuidv7();
    const key = exportKey(claims.workspaceId, packageId);
    const dataKey = randomBytes(32);
    await client.query(
      "INSERT INTO background_jobs (workspace_id, id, job_type, job_version, status, deduplication_key, command_operation_id, input_ref) VALUES ($1, $2, 'exports.build', '1', 'QUEUED', $3, $4, $5)",
      [claims.workspaceId, jobId, dedup, operationId, JSON.stringify({ source: "export", packageId })],
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
    await client.query(
      "INSERT INTO export_packages (workspace_id, id, job_id, requested_by, cutoff, status, object_key, data_key, expires_at) VALUES ($1, $2, $3, $4, now(), 'BUILDING', $5, $6, now() + ($7 || ' hours')::interval)",
      [claims.workspaceId, packageId, jobId, actorId, key, dataKey, String(EXPORT_EXPIRY_HOURS)],
    );
    const view = await readPackageByJob(client, claims.workspaceId, jobId);
    if (!view) throw new Error("export package missing after accept");
    await client.query("UPDATE command_operations SET status = 'SUCCEEDED', response_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
      JSON.stringify({ packageId, jobId }),
      claims.workspaceId,
      operationId,
    ]);
    return { ok: true, result: { view, operationId, packageId, jobId, replayed: false } };
  }
  throw new Error("command_claim_unsettled");
}

export async function acceptExportJob(
  pool: Pool,
  claims: TenantClaims,
  actorId: string,
  session: Session,
  raw: unknown,
): Promise<ExportAcceptResult> {
  const input = validateExportAcceptInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (!isUuid(actorId)) throw new TenantDenied();
  if (session.keycloakSub === "") throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => acceptTx(client, claims, actorId, session, input));
  if (!outcome.ok) throw new ExportError(outcome.code);
  return outcome.result;
}

// ---- Spreadsheet-safe CSV -----------------------------------------------

/** Prefix spreadsheet formula-control leading cells so exports open safely. */
export function csvCell(value: string): string {
  const trimmed = value.replace(/^[\s\uFEFF]+/, "");
  if (/^[=+\-@\t\r]/.test(trimmed)) return `'${value}`;
  return value;
}

function csvRow(cells: string[]): string {
  return cells.map((c) => (/[",\n\r]/.test(c) || c !== c.trim() ? `"${c.replaceAll('"', '""')}"` : c)).join(",");
}

// ---- Snapshot ------------------------------------------------------------

type Snapshot = { sections: Record<string, Record<string, string>[]>; counts: Record<string, number> };

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) return v.toString("hex");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function destringify(rows: Record<string, unknown>[]): Record<string, string>[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, str(v)])));
}

/** Read every exported section inside ONE repeatable-read tenant transaction: a consistent cutoff snapshot without holding it across the upload. */
async function snapshotWorkspace(pool: Pool, claims: TenantClaims, requesterUserId: string, cutoff: string): Promise<Snapshot> {
  return withTenant(
    pool,
    claims,
    async (client) => {
      const sections: Record<string, Record<string, string>[]> = {};
      const get = async (name: string, sql: string, params: unknown[] = []): Promise<void> => {
        const found = await client.query(sql, params as unknown[]);
        sections[name] = destringify(found.rows as Record<string, unknown>[]);
      };
      const ws = await client.query("SELECT id, name, base_currency_code, timezone, locale FROM workspaces WHERE id = $1", [claims.workspaceId]);
      sections["workspace"] = destringify(ws.rows as Record<string, unknown>[]);
      await get("membership", "SELECT user_id, role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [claims.workspaceId, requesterUserId]);
      await get("accounts", "SELECT id, name, base_currency_code, archived, source, version, created_at, updated_at FROM accounts WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("transactions", "SELECT id, account_id, amount_minor, currency, direction, effective_date, description, source_link_id, import_id, import_row_no, observation_id, category_id, version, financial_kind, linked_account_id, created_at FROM transactions WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("manualTransactions", "SELECT id, account_id, amount_minor, currency, direction, effective_date, description, balance_snapshot_id, actor_id, reference, category_id, version, financial_kind, linked_account_id, created_at FROM manual_transactions WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("balanceSnapshots", "SELECT id, account_id, as_of_date, amount_minor, currency, source, provenance, freshness, reconciliation_state, created_at FROM balance_snapshots WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("balanceAudit", "SELECT id, snapshot_id, account_id, action, prior_amount_minor, new_amount_minor, currency, reason, actor_id, created_at FROM balance_audit WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("imports", "SELECT id, data_source_id, idempotency_key, file_name, file_sha256, parser_version, status, row_count, staged_count, review_count, rejected_count, parsed_rows, error_code, error_summary, started_at, completed_at, source_columns, created_at FROM imports WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("dataSources", "SELECT id, type, name, status, created_at FROM data_sources WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("parsedObservations", "SELECT import_id, row_no, status, observation_id, amount_minor, currency, direction, effective_date, description, reasons, raw_cells, source_sheet, created_at FROM parsed_observations WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, import_id, row_no", [claims.workspaceId, cutoff]);
      await get("reviewDecisions", "SELECT id, source_link_id, decision, target_transaction_id, actor_id, created_at FROM review_decisions WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("sourceLinks", "SELECT id, import_id, import_row_no, observation_id, target_transaction_id, status, match_reason, resolved_at, resolved_by, created_at FROM source_links WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("importCommitBatches", "SELECT id, idempotency_key, status, total_files, completed_files, total_rows, total_staged, total_matched, total_review, total_rejected, error_code, started_at, completed_at FROM import_commit_batches WHERE workspace_id = $1 AND started_at <= $2 ORDER BY started_at, id", [claims.workspaceId, cutoff]);
      await get("categories", "SELECT id, parent_id, name, system_category_id, archived_at, created_at FROM categories WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("tags", "SELECT id, name, normalized_name, archived_at, created_at FROM tags WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("transactionTags", "SELECT transaction_id, tag_id FROM transaction_tags WHERE workspace_id = $1 ORDER BY transaction_id, tag_id", [claims.workspaceId]);
      await get("goals", "SELECT id, name, goal_type, status, target_amount_minor, currency_code, target_date, priority, notes, version, created_at FROM goals WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("goalAllocations", "SELECT id, goal_id, account_id, allocation_type, amount_minor, currency_code, version, created_at FROM goal_allocations WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("artifacts", "SELECT id, name, description, active_version_id, archived_at, created_at FROM artifacts WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("artifactVersions", "SELECT id, artifact_id, manifest, source_hash, build_hash, status, error_class, error_message, settled_at, source_html, source_css, source_js, created_at FROM artifact_versions WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("artifactState", "SELECT artifact_id, version_id, schema_version, state, updated_at FROM artifact_state WHERE workspace_id = $1 AND updated_at <= $2 ORDER BY artifact_id", [claims.workspaceId, cutoff]);
      await get("artifactStateSnapshots", "SELECT id, artifact_id, version_id, schema_version, state, migration_chain, created_at FROM artifact_state_snapshots WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("savedAnalyses", "SELECT id, status, data_revision, policy_version, cutoff_at, window_started_at, window_closed_at, commit_ids, dispatches_used, tool_calls_used, tokens_reserved, cost_reserved_minor, coverage_warnings, report, error_code, error_class, started_at, completed_at FROM deep_analysis_runs WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("savedAnalysisFindings", "SELECT id, run_id, kind, title, body, amount_minor, currency, evidence, created_at FROM deep_analysis_findings WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      // Own conversations only: threads created by the requester, with their
      // turns, tool calls (via attempts of those turns) and activity. Other
      // members' private chats are excluded even for owners.
      await get("conversations", "SELECT id, title, status, created_at, artifact_id FROM chat_threads WHERE workspace_id = $1 AND created_by = $2 AND created_at <= $3 ORDER BY created_at, id", [claims.workspaceId, requesterUserId, cutoff]);
      await get("conversationTurns", "SELECT t.id, t.thread_id, t.role, t.status, t.body, t.created_at FROM chat_turns t JOIN chat_threads th ON th.workspace_id = t.workspace_id AND th.id = t.thread_id WHERE t.workspace_id = $1 AND th.created_by = $2 AND t.created_at <= $3 ORDER BY t.created_at, t.id", [claims.workspaceId, requesterUserId, cutoff]);
      await get(
        "conversationToolCalls",
        "SELECT c.id, c.step, c.tool_name, c.args_hash, c.result_bytes, c.result_rows, c.evidence_ids, c.status, c.error_code, c.created_at FROM chat_tool_calls c JOIN chat_attempts a ON a.workspace_id = c.workspace_id AND a.id = c.attempt_id JOIN chat_turns t ON t.workspace_id = c.workspace_id AND t.id = a.turn_id JOIN chat_threads th ON th.workspace_id = c.workspace_id AND th.id = t.thread_id WHERE c.workspace_id = $1 AND th.created_by = $2 AND c.created_at <= $3 ORDER BY c.created_at, c.id",
        [claims.workspaceId, requesterUserId, cutoff],
      );
      await get("conversationActivity", "SELECT a.thread_id, a.seq, a.kind, a.turn_id, a.created_at FROM chat_activity a JOIN chat_threads th ON th.workspace_id = a.workspace_id AND th.id = a.thread_id WHERE a.workspace_id = $1 AND th.created_by = $2 AND a.created_at <= $3 ORDER BY a.thread_id, a.seq", [claims.workspaceId, requesterUserId, cutoff]);
      // Own attributable activity: audit rows where the requester acted, plus
      // member-visible notices addressed to the requester.
      await get("activity", "SELECT id, actor_type, entity_type, entity_id, action, before_state, after_state, reason, operation_id, created_at FROM audit_events WHERE workspace_id = $1 AND actor_user_id = $2 AND created_at <= $3 ORDER BY created_at, id", [claims.workspaceId, requesterUserId, cutoff]);
      await get("notices", "SELECT id, source_event, kind, title, body, link_href, read_at, created_at FROM notices WHERE workspace_id = $1 AND user_id = $2 AND created_at <= $3 ORDER BY created_at, id", [claims.workspaceId, requesterUserId, cutoff]);
      await get("fxManualRates", "SELECT rate_date, base_currency, target_currency, rate, auditor, source, created_at FROM fx_rates_manual WHERE workspace_id = $1 AND created_at <= $2 ORDER BY rate_date, base_currency, target_currency", [claims.workspaceId, cutoff]);
      await get("projectionSettings", "SELECT horizon_days, baseline_weeks, safety_floor_minor, savings_included, version, updated_at FROM projection_settings WHERE workspace_id = $1", [claims.workspaceId]);
      await get("assumptions", "SELECT id, assumption_type, status, valid_from, valid_to, value, scope_key, origin, confidence, supersedes_id, actor_id, version, created_at FROM financial_assumptions WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("recurringOverrides", "SELECT id, fingerprint, status, kind, day_of_month, version, created_at FROM recurring_overrides WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("scenarios", "SELECT id, name, status, parent_scenario_id, version, created_at FROM scenarios WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      await get("scenarioOverrides", "SELECT id, scenario_id, override_type, effective_from, effective_to, payload, version, created_at FROM scenario_overrides WHERE workspace_id = $1 AND created_at <= $2 ORDER BY created_at, id", [claims.workspaceId, cutoff]);
      const counts: Record<string, number> = {};
      for (const [name, rows] of Object.entries(sections)) counts[name] = rows.length;
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total > MAX_EXPORT_ROWS) throw new ExportError("too_large");
      return { sections, counts };
    },
    "REPEATABLE READ",
  );
}

function buildTransactionsCsv(snap: Snapshot): string {
  const lines = ["id,source,account_id,date,description,amount_minor,currency,direction,import_id"];
  for (const t of snap.sections["transactions"] ?? []) {
    lines.push(csvRow([t["id"] ?? "", "imported", t["account_id"] ?? "", t["effective_date"] ?? "", csvCell(t["description"] ?? ""), t["amount_minor"] ?? "", t["currency"] ?? "", t["direction"] ?? "", t["import_id"] ?? ""]));
  }
  for (const t of snap.sections["manualTransactions"] ?? []) {
    lines.push(csvRow([t["id"] ?? "", "manual", t["account_id"] ?? "", t["effective_date"] ?? "", csvCell(t["description"] ?? ""), t["amount_minor"] ?? "", t["currency"] ?? "", t["direction"] ?? "", ""]));
  }
  return `${lines.join("\n")}\n`;
}

function buildManifest(packageId: string, workspaceId: string, cutoff: string, generatedAt: string, counts: Record<string, number>): Record<string, unknown> {
  return {
    format: EXPORT_FORMAT,
    exportId: packageId,
    workspaceId,
    cutoff,
    generatedAt,
    schemaVersion: "041_exports",
    currencyConventions: "amounts are exact decimal strings in minor units with ISO-4217 currency codes; see currencyExponent table in money.ts",
    dateConventions: "dates are ISO-8601 calendar days (effective_date, as_of_date, rate_date) or UTC instants (created_at); workspace timezone is recorded in data.workspace",
    counts,
    excluded: [
      { section: "other_members_conversations", reason: "private to other members even when the requester owns the workspace" },
      { section: "other_members_activity", reason: "audit/notices attributable to other members stay private" },
      { section: "users_and_auth_subjects", reason: "identity data is never exported" },
      { section: "ai_policy_and_usage", reason: "operational policy/usage internals, not workspace data" },
      { section: "jobs_outbox_queue", reason: "operational transport state, not workspace data" },
      { section: "fx_ecb_cache_and_valuations", reason: "re-derivable public cache and derived values" },
      { section: "projection_runs", reason: "derived outputs; re-runnable from exported inputs" },
      { section: "deep_analysis_steps", reason: "operational step detail; the report and findings are exported" },
      { section: "raw_upload_bytes", reason: "separate retention lifecycle (arch 455); metadata exported, bytes excluded" },
      { section: "secrets_and_credentials", reason: "never exported" },
    ],
  };
}

// ---- Encryption -----------------------------------------------------------

const ENVELOPE_VERSION = 0x01;

function encryptEnvelope(dataKey: Buffer, aad: string, plaintext: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, ciphertext, tag]);
}

function decryptEnvelope(dataKey: Buffer, aad: string, stored: Uint8Array): Buffer {
  if (stored.length < 1 + 12 + 16 || stored[0] !== ENVELOPE_VERSION) throw new Error("export envelope refused");
  const iv = Buffer.from(stored.subarray(1, 13));
  const tag = Buffer.from(stored.subarray(stored.length - 16));
  const ciphertext = Buffer.from(stored.subarray(13, stored.length - 16));
  const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function envelopeAad(workspaceId: string, packageId: string, cutoff: string): string {
  return `${workspaceId}.${packageId}.${cutoff}`;
}

// ---- Worker ---------------------------------------------------------------

export type ExportProcessOutcome = "applied" | "duplicate-terminal-noop";

async function failPackage(pool: Pool, route: JobRoute & { jobId: string }, claim: Pick<Claim, "attemptId" | "generation">, code: string): Promise<void> {
  await withTenant(pool, { userId: route.acceptedBy, workspaceId: route.workspaceId }, async (client) => {
    const guard = await fencedGuard(client, route, claim);
    if (!guard.ok) {
      await markAttempt(client, route, claim.attemptId, guard.reason === "cancelled" ? "CANCELLED" : "STALE");
      return;
    }
    await client.query("UPDATE background_jobs SET status = 'FAILED_FINAL', completed_at = now(), error_code = $3, progress_stage = 'failed', updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'RUNNING' AND attempt_generation = $4 AND cancel_requested_at IS NULL", [
      route.workspaceId,
      route.jobId,
      code,
      claim.generation,
    ]);
    await client.query("UPDATE export_packages SET status = 'FAILED_FINAL', error_code = $3, completed_at = now() WHERE workspace_id = $1 AND job_id = $2 AND status = 'BUILDING'", [
      route.workspaceId,
      route.jobId,
      code,
    ]);
    await client.query("INSERT INTO background_job_results (workspace_id, id, background_job_id, result_kind) VALUES ($1, $2, $3, 'export-ready') ON CONFLICT (workspace_id, background_job_id) DO NOTHING", [
      route.workspaceId,
      uuidv7(),
      route.jobId,
    ]);
    await markAttempt(client, route, claim.attemptId, "SUCCEEDED");
    await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
  });
}

/**
 * Fenced export builder: claim -> snapshot checkpoint -> encrypt+PUT ->
 * fenced READY publish. Crash between PUT and publish is safe: retry
 * rebuilds the same snapshot (cutoff is frozen at accept) and overwrites the
 * same object key before publishing. A superseded or cancelled attempt
 * publishes nothing.
 */
export async function processExportJob(
  pool: Pool,
  backgroundJobId: string,
  s3: S3Config,
  opts?: { workerId?: string; leaseMs?: number; bullmqJobId?: string },
): Promise<ExportProcessOutcome> {
  if (!isUuid(backgroundJobId)) throw new TenantInvalid();
  const route = await resolveJobRoute(pool, backgroundJobId);
  if (!route) return "duplicate-terminal-noop";
  const full = { ...route, jobId: backgroundJobId };
  const workerId = validateWorkerId(opts?.workerId ?? `exports-worker-${process.pid}`);
  const leaseMs = opts?.leaseMs === undefined ? DEFAULT_RUNTIME_LEASE_MS : validateLeaseMs(opts.leaseMs);
  let claim: Claim;
  try {
    claim = await claimAttempt(pool, full, workerId, leaseMs, opts?.bullmqJobId);
  } catch (err) {
    if (err instanceof RecoveryError && (err.code === "not_found" || err.code === "terminal" || err.code === "cancelled")) {
      return "duplicate-terminal-noop";
    }
    throw err;
  }
  const pick = { attemptId: claim.attemptId, generation: claim.generation };
  try {
    const snap = await checkpointAttempt(pool, full, pick, "snapshot");
    if (!snap.ok) return "duplicate-terminal-noop";
    // Package identity + frozen cutoff + data key, read under tenancy (the
    // worker re-enters with the accepting member like every other job).
    const meta = await withTenant(pool, { userId: full.acceptedBy, workspaceId: full.workspaceId }, async (client) => {
      const found = await client.query("SELECT id, cutoff, object_key, data_key FROM export_packages WHERE workspace_id = $1 AND job_id = $2 AND status = 'BUILDING'", [
        full.workspaceId,
        backgroundJobId,
      ]);
      if ((found.rowCount ?? 0) === 0) return null;
      return found.rows[0] as { id: string; cutoff: Date; object_key: string; data_key: Buffer };
    });
    if (!meta) return "duplicate-terminal-noop";
    const cutoff = meta.cutoff.toISOString();
    const snapData = await snapshotWorkspace(pool, { userId: full.acceptedBy, workspaceId: full.workspaceId }, full.acceptedBy, cutoff);
    const generatedAt = new Date().toISOString();
    const manifest = buildManifest(meta.id, full.workspaceId, cutoff, generatedAt, snapData.counts);
    const envelope = { format: EXPORT_FORMAT, manifest, data: snapData.sections, csv: { transactions: buildTransactionsCsv(snapData) } };
    const plaintext = Buffer.from(JSON.stringify(envelope), "utf8");
    if (plaintext.byteLength > MAX_EXPORT_OBJECT_BYTES) {
      await failPackage(pool, full, pick, "export_too_large");
      return "applied";
    }
    const stored = encryptEnvelope(meta.data_key, envelopeAad(full.workspaceId, meta.id, cutoff), plaintext);
    const put = await checkpointAttempt(pool, full, pick, "stored");
    if (!put.ok) return "duplicate-terminal-noop";
    await s3PutExport(s3, meta.object_key, stored, "application/octet-stream");
    // Fenced publish: READY + immutable result + SUCCEEDED + index retire in
    // one transaction; losers change only their attempt row.
    const published = await withTenant(pool, { userId: full.acceptedBy, workspaceId: full.workspaceId }, async (client) => {
      const guard = await fencedGuard(client, full, pick);
      if (!guard.ok) {
        await markAttempt(client, full, pick.attemptId, guard.reason === "cancelled" ? "CANCELLED" : "STALE");
        if (guard.reason === "cancelled") {
          await client.query("UPDATE export_packages SET status = 'FAILED_FINAL', error_code = 'cancelled', completed_at = now() WHERE workspace_id = $1 AND job_id = $2 AND status = 'BUILDING'", [
            full.workspaceId,
            backgroundJobId,
          ]);
        }
        return false;
      }
      const terminal = await client.query(
        "UPDATE background_jobs SET status = 'SUCCEEDED', completed_at = now(), progress_stage = 'effect', updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'RUNNING' AND attempt_generation = $3 AND cancel_requested_at IS NULL",
        [full.workspaceId, backgroundJobId, pick.generation],
      );
      if ((terminal.rowCount ?? 0) !== 1) {
        await markAttempt(client, full, pick.attemptId, "STALE");
        return false;
      }
      await client.query(
        "UPDATE export_packages SET status = 'READY', manifest = $3, section_counts = $4, completed_at = now() WHERE workspace_id = $1 AND job_id = $2 AND status = 'BUILDING'",
        [full.workspaceId, backgroundJobId, JSON.stringify(manifest), JSON.stringify(snapData.counts)],
      );
      await client.query("INSERT INTO background_job_results (workspace_id, id, background_job_id, result_kind) VALUES ($1, $2, $3, 'export-ready') ON CONFLICT (workspace_id, background_job_id) DO NOTHING", [
        full.workspaceId,
        uuidv7(),
        backgroundJobId,
      ]);
      await markAttempt(client, full, pick.attemptId, "SUCCEEDED");
      await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [full.workspaceId, backgroundJobId]);
      return true;
    });
    return published ? "applied" : "duplicate-terminal-noop";
  } catch (err) {
    if (err instanceof ExportError && err.code === "too_large") {
      await failPackage(pool, full, pick, "export_too_large");
      return "applied";
    }
    throw err;
  }
}

// ---- Reads, one-use download, expiry ----------------------------------------

type PackageRow = Parameters<typeof rowToView>[0] & { object_key: string | null; data_key: Buffer | null };

async function findPackage(client: PoolClient, workspaceId: string, packageId: string): Promise<PackageRow | null> {
  const found = await client.query(
    "SELECT workspace_id, id, job_id, status, cutoff, expires_at, downloaded_at, section_counts, manifest, error_code, object_key, data_key FROM export_packages WHERE workspace_id = $1 AND id = $2",
    [workspaceId, packageId],
  );
  if ((found.rowCount ?? 0) === 0) return null;
  return found.rows[0] as PackageRow;
}

/** Lazy expiry inside the caller's tenant transaction: past-due READY rows lose their object before any read is served. */
async function expireIfDue(client: PoolClient, s3: S3Config | null, workspaceId: string, row: PackageRow): Promise<boolean> {
  if (row.status !== "READY" || new Date(row.expires_at as unknown as string).getTime() > Date.now()) return false;
  if (typeof row.object_key === "string" && row.object_key) {
    // Without object storage configured the bytes cannot be removed: leave
    // the row READY (the download consume still refuses past-expiry reads,
    // so no bytes leak) until storage returns or S01c sweeps it.
    if (!s3) return false;
    await s3DeleteExport(s3, row.object_key);
  }
  await client.query("UPDATE export_packages SET status = 'EXPIRED', object_key = NULL, data_key = NULL, manifest = NULL, section_counts = NULL, completed_at = coalesce(completed_at, now()) WHERE workspace_id = $1 AND id = $2 AND status = 'READY'", [
    workspaceId,
    row.id,
  ]);
  return true;
}

export async function readExport(pool: Pool, claims: TenantClaims, packageId: string, s3?: S3Config): Promise<ExportView | null> {
  if (!isUuid(packageId)) return null;
  return withTenant(pool, claims, async (client) => {
    const row = await findPackage(client, claims.workspaceId, packageId);
    if (!row) return null;
    if (await expireIfDue(client, s3 ?? null, claims.workspaceId, row)) {
      const again = await findPackage(client, claims.workspaceId, packageId);
      return again ? rowToView(again) : null;
    }
    return rowToView(row);
  });
}

export async function listExports(pool: Pool, claims: TenantClaims, s3?: S3Config): Promise<ExportView[]> {
  return withTenant(pool, claims, async (client) => {
    const found = await client.query(
      "SELECT workspace_id, id, job_id, status, cutoff, expires_at, downloaded_at, section_counts, manifest, error_code, object_key, data_key FROM export_packages WHERE workspace_id = $1 ORDER BY created_at DESC, id LIMIT 100",
      [claims.workspaceId],
    );
    const views: ExportView[] = [];
    for (const row of found.rows as PackageRow[]) {
      if (await expireIfDue(client, s3 ?? null, claims.workspaceId, row)) {
        const again = await findPackage(client, claims.workspaceId, row.id);
        if (again) views.push(rowToView(again));
        continue;
      }
      views.push(rowToView(row));
    }
    return views;
  });
}

export type ExportDownload = { filename: string; bytes: Buffer; packageId: string };

/**
 * One-use download: atomically consumes the READY package (downloaded_at,
 * audit row) under tenancy, then fetches + decrypts the object. The step-up
 * must be fresh at download time. Second downloads, expired packages and
 * foreign ids return null (uniform 404); stale step-up throws (403).
 */
export async function serveExportDownload(
  pool: Pool,
  s3: S3Config,
  claims: TenantClaims,
  actorId: string,
  session: Session,
  packageId: string,
): Promise<ExportDownload | null> {
  if (!isUuid(packageId) || !isUuid(actorId)) return null;
  assertFreshStepUp(session);
  const auditId = uuidv7();
  const consumed = await withTenant(pool, claims, async (client) => {
    const row = await findPackage(client, claims.workspaceId, packageId);
    if (!row) return null;
    if (await expireIfDue(client, s3, claims.workspaceId, row)) return null;
    const take = await client.query(
      "UPDATE export_packages SET downloaded_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'READY' AND downloaded_at IS NULL AND expires_at > now() RETURNING object_key, data_key, cutoff, id",
      [claims.workspaceId, packageId],
    );
    if ((take.rowCount ?? 0) === 0) return null;
    const taken = take.rows[0] as { object_key: string; data_key: Buffer; cutoff: Date; id: string };
    if (!taken.object_key || !taken.data_key) return null;
    await client.query(
      "INSERT INTO audit_events (workspace_id, id, actor_type, actor_user_id, entity_type, entity_id, action) VALUES ($1, $2, 'user', $3, 'export_package', $4, 'downloaded')",
      [claims.workspaceId, auditId, actorId, packageId],
    );
    return taken;
  });
  if (!consumed) return null;
  let plaintext: Buffer;
  try {
    const stored = await s3GetExport(s3, consumed.object_key, MAX_EXPORT_OBJECT_BYTES);
    plaintext = decryptEnvelope(consumed.data_key, envelopeAad(claims.workspaceId, consumed.id, consumed.cutoff.toISOString()), stored);
  } catch {
    // The single use must not burn on a storage failure that delivered no
    // bytes: reopen the package and retract the download audit row (by its
    // exact id) so a retry stays possible and history stays truthful.
    await withTenant(pool, claims, async (client) => {
      await client.query("UPDATE export_packages SET downloaded_at = NULL WHERE workspace_id = $1 AND id = $2 AND status = 'READY'", [
        claims.workspaceId,
        packageId,
      ]);
      await client.query("DELETE FROM audit_events WHERE workspace_id = $1 AND id = $2 AND action = 'downloaded'", [claims.workspaceId, auditId]);
    });
    return null;
  }
  return { filename: `moneo-export-${consumed.id}.json`, bytes: plaintext, packageId: consumed.id };
}

/**
 * Member-triggered expiry of one package: deletes the object, then marks the
 * row EXPIRED with keys nulled. Failed object deletes stay READY (visible,
 * retryable) and return expired:false. Foreign ids return null (uniform 404).
 */
export async function expireExportPackage(
  pool: Pool,
  s3: S3Config,
  claims: TenantClaims,
  packageId: string,
): Promise<{ expired: boolean } | null> {
  if (!isUuid(packageId)) return null;
  return withTenant(pool, claims, async (client) => {
    const row = await findPackage(client, claims.workspaceId, packageId);
    if (!row) return null;
    if (row.status === "EXPIRED") return { expired: true };
    if (row.status !== "READY") return { expired: false };
    if (typeof row.object_key === "string" && row.object_key) {
      try {
        await s3DeleteExport(s3, row.object_key);
      } catch {
        return { expired: false };
      }
    }
    await client.query("UPDATE export_packages SET status = 'EXPIRED', object_key = NULL, data_key = NULL, manifest = NULL, section_counts = NULL, completed_at = coalesce(completed_at, now()) WHERE workspace_id = $1 AND id = $2 AND status = 'READY'", [
      claims.workspaceId,
      packageId,
    ]);
    return { expired: true };
  });
}

/** Cancel the export job behind a package (generic durable cancel; committed READY packages are unaffected). */
export async function cancelExport(pool: Pool, claims: TenantClaims, packageId: string): Promise<{ status: string } | null> {
  if (!isUuid(packageId)) return null;
  const jobId = await withTenant(pool, claims, async (client) => {
    const row = await findPackage(client, claims.workspaceId, packageId);
    if (!row) return null;
    return row.job_id;
  });
  if (!jobId) return null;
  const result = await cancelJob(pool, claims, jobId);
  if (!result) return null;
  // A cancelled-before-claim job never reaches the worker: close the package
  // row here so it cannot strand as BUILDING. The worker's own cancelled
  // fence owns the RUNNING case (same terminal state, idempotent).
  if (result.status === "CANCELLED") {
    await withTenant(pool, claims, async (client) => {
      await client.query("UPDATE export_packages SET status = 'FAILED_FINAL', error_code = 'cancelled', completed_at = coalesce(completed_at, now()) WHERE workspace_id = $1 AND id = $2 AND status = 'BUILDING'", [
        claims.workspaceId,
        packageId,
      ]);
    });
  }
  return { status: result.status };
}
