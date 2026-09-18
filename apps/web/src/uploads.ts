// E02-S03 quarantine upload + bounded parse (architecture ##5-9 adapted to
// composite tenant keys, ##181-183, 202, 216-218, 443-446, 455-456; E00-S03
// parser decision; S03 refinement pins MinIO + ClamAV test images).
// Original bytes live ONLY in the private quarantine prefix under generated
// keys; PG keeps metadata/hashes/staged cells. Bytes never enter logs,
// Redis, error bodies or model context — logs carry size, type, hash prefix
// and counts only. The parser/scanner children receive file bytes and the
// mapping profile only — never DB/model credentials. Deterministic chunked
// persist with (import,row) uniqueness makes retry/kill converge without
// duplicate observations and without orphan promotion.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";
import { sanitizeFilename } from "./multipart.ts";
import { assertQuarantineKey, quarantineKey, s3Get, s3Put, type S3Config } from "./s3.ts";
import { clamdScan, type ClamConfig } from "./clamav.ts";
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
import { resolveJobRoute, type JobRoute } from "./jobs.ts";

// Local contract shapes mirroring proof/import/parser.ts across the child
// JSON boundary (runtime crosses as untyped JSON; the stack tests pin the
// values against the manifest oracle, so drift fails loudly). Importing the
// proof tree here would break the web/worker build roots.
export type UploadAmountFormat = { decimalSep: "." | ","; thousandsSep: "." | "," | "" };
export type UploadProfile = {
  delimiter: "," | ";";
  dateFormat: "iso" | "de" | "us" | "excel-serial";
  amount: ({ kind: "signed" } & UploadAmountFormat) | ({ kind: "debit-credit" } & UploadAmountFormat);
  columns: { date: string; description: string; amount?: string; debit?: string; credit?: string; currency?: string };
  defaultCurrency?: string;
};
export type UploadProposal =
  | { kind: "accepted"; rowNumber: number; observationId: string; amountMinor: string; currency: string; direction: "INFLOW" | "OUTFLOW"; effectiveDate: string; description: string; source: { sheet: string | null } }
  | { kind: "needs_review"; rowNumber: number; observationId: string; reasons: string[]; raw: Record<string, string>; source: { sheet: string | null } }
  | { kind: "rejected"; rowNumber: number; observationId: string; reasons: string[]; raw: Record<string, string>; source: { sheet: string | null } };
export type UploadFileErrorCode =
  | "unsupported-encoding" | "corrupt" | "upload-limit" | "row-limit" | "column-limit"
  | "decompressed-limit" | "too-many-entries" | "unsupported-format" | "unsupported-schema"
  | "external-link" | "internal";

export const PARSER_VERSION = "proof-import-1";
export const IMPORTS_PARSE = "imports.parse";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_CELL_BYTES = 1024 * 1024;
export const OBSERVE_CHUNK_ROWS = 1000;
export const OBSERVE_PAGE_LIMIT = 100;

export type UploadConfig = {
  s3: S3Config;
  clamav: ClamConfig;
  parserChild: string;
  parseDeadlineMs: number;
  scanTimeoutMs: number;
};

export type UploadConfigSummary = {
  enabled: true;
  endpoint: string;
  bucket: string;
  clamav: string;
  parserChild: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`E02-S03 uploads disabled: missing ${name} (no secret value logged).`);
  return value;
}

/** Fail-closed loader: uploads stay disabled unless every input is present. */
export function loadUploadConfig(): UploadConfig {
  if (process.env["UPLOADS_ENABLED"] !== "1") throw new Error("E02-S03 uploads disabled: set UPLOADS_ENABLED=1 with S3 + scanner configuration.");
  const port = Number(process.env["CLAMAV_PORT"] ?? "3310");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("E02-S03 uploads disabled: CLAMAV_PORT must be an integer 1-65535.");
  const parseDeadlineMs = Number(process.env["PARSE_DEADLINE_MS"] ?? "60000");
  if (!Number.isInteger(parseDeadlineMs) || parseDeadlineMs < 1000 || parseDeadlineMs > 300_000) {
    throw new Error("E02-S03 uploads disabled: PARSE_DEADLINE_MS must be an integer 1000-300000.");
  }
  return {
    s3: {
      endpoint: requiredEnv("S3_ENDPOINT"),
      region: process.env["S3_REGION"] ?? "us-east-1",
      accessKey: requiredEnv("S3_ACCESS_KEY"),
      secretKey: requiredEnv("S3_SECRET_KEY"),
      bucket: requiredEnv("S3_BUCKET"),
    },
    clamav: { host: process.env["CLAMAV_HOST"] ?? "127.0.0.1", port },
    parserChild: process.env["PARSER_CHILD"] ?? join(process.cwd(), "proof", "import", "dist", "child.js"),
    parseDeadlineMs,
    scanTimeoutMs: 60_000,
  };
}

/** Redacted summary for logs/tests: endpoints and paths only, never keys. */
export function uploadConfigSummary(config: UploadConfig): UploadConfigSummary {
  return {
    enabled: true,
    endpoint: config.s3.endpoint,
    bucket: config.s3.bucket,
    clamav: `${config.clamav.host}:${config.clamav.port}`,
    parserChild: config.parserChild,
  };
}

export class UploadError extends Error {
  readonly code: "invalid_request" | "idempotency_reuse" | "not_found" | "payload_too_large";
  readonly reason?: string;
  constructor(code: UploadError["code"], reason?: string) {
    super(reason ?? code);
    this.code = code;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Mapping profile validation (S03 accepts an explicit profile; S04 owns
// inference + stored profiles). Strict allowlists over the local
// UploadProfile shape (mirrors the proof parser's ImportProfile across the
// child JSON boundary) — anything else is invalid_request, never guessed.
// ---------------------------------------------------------------------------

const GENERIC_PROFILE: UploadProfile = {
  delimiter: ",",
  dateFormat: "iso",
  amount: { kind: "signed", decimalSep: ".", thousandsSep: "" },
  columns: { date: "date", description: "description", amount: "amount", currency: "currency" },
};

function checkColumnName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || /[\r\n\x00]/.test(value)) throw new TenantInvalid();
  return value;
}

export function validateImportProfile(value: unknown): UploadProfile {
  if (value === undefined) return GENERIC_PROFILE;
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["delimiter", "dateFormat", "amount", "columns", "defaultCurrency"].includes(key)) throw new TenantInvalid();
  }
  const { delimiter, dateFormat, amount, columns, defaultCurrency } = v;
  if (delimiter !== "," && delimiter !== ";") throw new TenantInvalid();
  if (dateFormat !== "iso" && dateFormat !== "de" && dateFormat !== "us" && dateFormat !== "excel-serial") throw new TenantInvalid();
  if (typeof amount !== "object" || amount === null) throw new TenantInvalid();
  const a = amount as Record<string, unknown>;
  if (a["kind"] !== "signed" && a["kind"] !== "debit-credit") throw new TenantInvalid();
  const decimalSep = a["decimalSep"];
  const thousandsSep = a["thousandsSep"];
  if (decimalSep !== "." && decimalSep !== ",") throw new TenantInvalid();
  if (thousandsSep !== "." && thousandsSep !== "," && thousandsSep !== "") throw new TenantInvalid();
  if (decimalSep === thousandsSep) throw new TenantInvalid();
  if (typeof columns !== "object" || columns === null) throw new TenantInvalid();
  const c = columns as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!["date", "description", "amount", "debit", "credit", "currency"].includes(key)) throw new TenantInvalid();
  }
  if (typeof c["date"] !== "string" || typeof c["description"] !== "string") throw new TenantInvalid();
  const out: UploadProfile = {
    delimiter,
    dateFormat,
    amount: a["kind"] === "signed"
      ? { kind: "signed", decimalSep: decimalSep as "." | ",", thousandsSep: thousandsSep as "." | "," | "" }
      : { kind: "debit-credit", decimalSep: decimalSep as "." | ",", thousandsSep: thousandsSep as "." | "," | "" },
    columns: {
      date: checkColumnName(c["date"]),
      description: checkColumnName(c["description"]),
      ...(c["amount"] === undefined ? {} : { amount: checkColumnName(c["amount"]) }),
      ...(c["debit"] === undefined ? {} : { debit: checkColumnName(c["debit"]) }),
      ...(c["credit"] === undefined ? {} : { credit: checkColumnName(c["credit"]) }),
      ...(c["currency"] === undefined ? {} : { currency: checkColumnName(c["currency"]) }),
    },
  };
  if (defaultCurrency !== undefined) {
    if (typeof defaultCurrency !== "string" || !/^[A-Z]{3}$/.test(defaultCurrency)) throw new TenantInvalid();
    out.defaultCurrency = defaultCurrency;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Admission: extension allowlist + magic sniff. Deterministic, no content
// trust: .xlsx must be a ZIP container, .csv anything text-like. Anything
// else (including macro-enabled workbooks) is rejected before storage.
// ---------------------------------------------------------------------------

export type AdmittedKind = "csv" | "xlsx";

export function admitUpload(filename: string, bytes: Uint8Array): { kind: AdmittedKind; contentType: string } {
  const lower = filename.toLowerCase();
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (lower.endsWith(".xlsx")) {
    if (!isZip) throw new UploadError("invalid_request", "unsupported-format");
    return { kind: "xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  }
  if (lower.endsWith(".csv")) {
    if (isZip) throw new UploadError("invalid_request", "unsupported-format");
    return { kind: "csv", contentType: "text/csv" };
  }
  throw new UploadError("invalid_request", "unsupported-format");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImportView = {
  workspaceId: string;
  id: string;
  dataSourceId: string;
  fileName: string;
  parserVersion: string;
  status: "UPLOAD_REGISTERED" | "SCANNING" | "PARSING" | "STAGED" | "REJECTED";
  rowCount: string | null;
  stagedCount: string | null;
  reviewCount: string | null;
  rejectedCount: string | null;
  parsedRows: string;
  errorCode: string | null;
  jobId: string;
};

export type ObservationView = {
  rowNo: number;
  status: "STAGED" | "NEEDS_REVIEW" | "REJECTED";
  observationId: string;
  amountMinor: string | null;
  currency: string | null;
  direction: string | null;
  effectiveDate: string | null;
  description: string | null;
  reasons: unknown;
  sourceSheet: string | null;
};

type ImportRow = Record<string, string | null> & { id: string; workspace_id: string };

function rowToImportView(row: ImportRow, jobId: string): ImportView {
  const str = (v: string | null): string | null => (v === null ? null : String(v));
  return {
    workspaceId: row["workspace_id"],
    id: row["id"],
    dataSourceId: String(row["data_source_id"]),
    fileName: String(row["file_name"]),
    parserVersion: String(row["parser_version"]),
    status: row["status"] as ImportView["status"],
    rowCount: str(row["row_count"]),
    stagedCount: str(row["staged_count"]),
    reviewCount: str(row["review_count"]),
    rejectedCount: str(row["rejected_count"]),
    parsedRows: String(row["parsed_rows"]),
    errorCode: str(row["error_code"]),
    jobId,
  };
}

// ---------------------------------------------------------------------------
// Accept: bytes -> quarantine object + import/source/job/outbox/index rows.
// S3 PUT precedes the PG transaction (object stores cannot join it); a PG
// failure afterwards orphans quarantine bytes without metadata, which expire
// via the import retention marker lifecycle (E08 enforcement). The reverse
// order would leave user-visible imports pointing at missing objects.
// ---------------------------------------------------------------------------

export type AcceptUploadInput = {
  workspaceId: string;
  idempotencyKey: string;
  filename: string;
  bytes: Uint8Array;
  profile?: unknown;
};

export type AcceptUploadResult = { import: ImportView; jobId: string; dataSourceId: string; replayed: boolean };

async function findOrCreateDataSource(client: PoolClient, workspaceId: string, kind: AdmittedKind): Promise<string> {
  const type = kind === "csv" ? "csv_upload" : "xlsx_upload";
  const existing = await client.query("SELECT id FROM data_sources WHERE workspace_id = $1 AND type = $2 AND name = $3 ORDER BY created_at LIMIT 1", [
    workspaceId,
    type,
    "File upload",
  ]);
  if ((existing.rowCount ?? 0) > 0) return (existing.rows[0] as { id: string }).id;
  const id = uuidv7();
  await client.query("SAVEPOINT data_source_claim");
  try {
    await client.query("INSERT INTO data_sources (workspace_id, id, type, name, status) VALUES ($1, $2, $3, 'File upload', 'ACTIVE')", [
      workspaceId,
      id,
      type,
    ]);
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    await client.query("ROLLBACK TO SAVEPOINT data_source_claim");
    const winner = await client.query("SELECT id FROM data_sources WHERE workspace_id = $1 AND type = $2 AND name = $3 ORDER BY created_at LIMIT 1", [
      workspaceId,
      type,
      "File upload",
    ]);
    return (winner.rows[0] as { id: string }).id;
  }
  return id;
}

async function readImportTx(
  client: PoolClient,
  workspaceId: string,
  importId: string,
): Promise<{ row: ImportRow; jobId: string } | null> {
  const found = await client.query(
    "SELECT workspace_id, id, data_source_id, file_name, parser_version, status, row_count, staged_count, review_count, rejected_count, parsed_rows, error_code FROM imports WHERE workspace_id = $1 AND id = $2",
    [workspaceId, importId],
  );
  if ((found.rowCount ?? 0) === 0) return null;
  const job = await client.query("SELECT id FROM background_jobs WHERE workspace_id = $1 AND deduplication_key = $2", [workspaceId, `imports.parse:${importId}`]);
  if ((job.rowCount ?? 0) === 0) return null;
  return { row: found.rows[0] as ImportRow, jobId: (job.rows[0] as { id: string }).id };
}

export async function acceptUpload(
  pool: Pool,
  claims: TenantClaims,
  actorId: string,
  config: UploadConfig,
  raw: AcceptUploadInput,
): Promise<AcceptUploadResult> {
  if (raw.workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (!isUuid(raw.idempotencyKey) || !isUuid(actorId)) throw new TenantDenied();
  if (!(raw.bytes instanceof Uint8Array) || raw.bytes.byteLength === 0) throw new UploadError("invalid_request", "empty-file");
  if (raw.bytes.byteLength > MAX_UPLOAD_BYTES) throw new UploadError("payload_too_large", "upload-limit");
  const profile = validateImportProfile(raw.profile);
  const filename = sanitizeFilename(raw.filename);
  const admitted = admitUpload(filename, raw.bytes);
  const sha = sha256Hex(raw.bytes);

  // Fast path: same key + same bytes replays; same key + different bytes is
  // a conflicting reuse (fuzzy equality is never identity).
  const replay = await withTenant(pool, claims, async (client) => {
    const found = await client.query("SELECT id, file_sha256 AS sha FROM imports WHERE workspace_id = $1 AND idempotency_key = $2", [
      claims.workspaceId,
      raw.idempotencyKey,
    ]);
    if ((found.rowCount ?? 0) === 0) return null;
    const row = found.rows[0] as { id: string; sha: string };
    if (row.sha !== sha) return { conflict: true as const };
    const resumed = await readImportTx(client, claims.workspaceId, row.id);
    return resumed ? { ...resumed, conflict: false as const } : null;
  });
  if (replay && replay.conflict) throw new UploadError("idempotency_reuse", "idempotency_reuse");
  if (replay && !replay.conflict) {
    return { import: rowToImportView(replay.row, replay.jobId), jobId: replay.jobId, dataSourceId: String(replay.row["data_source_id"]), replayed: true };
  }

  // Store bytes first (object stores cannot join the PG transaction).
  const objectId = uuidv7();
  const objectKey = quarantineKey(claims.workspaceId, objectId);
  assertQuarantineKey(objectKey);
  await s3Put(config.s3, objectKey, raw.bytes, admitted.contentType);

  // A concurrent duplicate may win the import key meanwhile: converge on
  // the winner (same sha) or conflict (different sha). This attempt's
  // bytes stay orphaned in quarantine without metadata — bounded, expiring
  // via the retention lifecycle; tests delete their own keys.
  const outcome = await withTenant(pool, claims, async (client) => {
    const existing = await client.query("SELECT id, file_sha256 AS sha FROM imports WHERE workspace_id = $1 AND idempotency_key = $2", [
      claims.workspaceId,
      raw.idempotencyKey,
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      const row = existing.rows[0] as { id: string; sha: string };
      if (row.sha !== sha) return { conflict: true as const };
      const resumed = await readImportTx(client, claims.workspaceId, row.id);
      if (!resumed) throw new UploadError("invalid_request", "unknown-import");
      return { ...resumed, conflict: false as const };
    }
    const dataSourceId = await findOrCreateDataSource(client, claims.workspaceId, admitted.kind);
    const importId = uuidv7();
    const sourceObjectId = uuidv7();
    const jobId = uuidv7();
    const outboxId = uuidv7();
    await client.query(
      "INSERT INTO imports (workspace_id, id, data_source_id, idempotency_key, file_name, file_sha256, object_key, parser_version, status, started_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'UPLOAD_REGISTERED', now())",
      [claims.workspaceId, importId, dataSourceId, raw.idempotencyKey, filename, sha, objectKey, PARSER_VERSION],
    );
    await client.query(
      "INSERT INTO source_objects (workspace_id, id, import_id, object_key, size_bytes, sha256, status) VALUES ($1, $2, $3, $4, $5, $6, 'QUARANTINED')",
      [claims.workspaceId, sourceObjectId, importId, objectKey, raw.bytes.byteLength, sha],
    );
    const inputRef = JSON.stringify({ importId, profile, parserVersion: PARSER_VERSION });
    await client.query(
      "INSERT INTO background_jobs (workspace_id, id, job_type, job_version, status, deduplication_key, input_ref) VALUES ($1, $2, 'imports.parse', '1', 'QUEUED', $3, $4)",
      [claims.workspaceId, jobId, `imports.parse:${importId}`, inputRef],
    );
    const payload = JSON.stringify({ backgroundJobId: jobId });
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
    const created = await readImportTx(client, claims.workspaceId, importId);
    if (!created) throw new Error("import row missing after accept");
    return { ...created, conflict: false as const, fresh: true as const, dataSourceId };
  });
  if (outcome.conflict) throw new UploadError("idempotency_reuse", "idempotency_reuse");
  return {
    import: rowToImportView(outcome.row, outcome.jobId),
    jobId: outcome.jobId,
    dataSourceId: "fresh" in outcome ? (outcome.dataSourceId as string) : String(outcome.row["data_source_id"]),
    replayed: !("fresh" in outcome),
  };
}

// ---------------------------------------------------------------------------
// Reads (no bytes ever served)
// ---------------------------------------------------------------------------

export async function readImport(pool: Pool, claims: TenantClaims, importId: string): Promise<ImportView | null> {
  if (!isUuid(importId)) return null;
  return withTenant(pool, claims, async (client) => {
    const found = await readImportTx(client, claims.workspaceId, importId);
    return found ? rowToImportView(found.row, found.jobId) : null;
  });
}

export async function listObservations(
  pool: Pool,
  claims: TenantClaims,
  importId: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ rows: ObservationView[]; total: number }> {
  if (!isUuid(importId)) return { rows: [], total: 0 };
  const limit = opts?.limit ?? OBSERVE_PAGE_LIMIT;
  const offset = opts?.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > OBSERVE_PAGE_LIMIT) throw new TenantInvalid();
  if (!Number.isInteger(offset) || offset < 0) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    const own = await client.query("SELECT 1 FROM imports WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, importId]);
    if ((own.rowCount ?? 0) === 0) return { rows: [], total: 0 };
    const total = await client.query("SELECT count(*)::int AS n FROM parsed_observations WHERE workspace_id = $1 AND import_id = $2", [
      claims.workspaceId,
      importId,
    ]);
    const rows = await client.query(
      "SELECT row_no AS \"rowNo\", status, observation_id AS \"observationId\", amount_minor AS \"amountMinor\", currency, direction, effective_date AS \"effectiveDate\", description, reasons, source_sheet AS \"sourceSheet\" FROM parsed_observations WHERE workspace_id = $1 AND import_id = $2 ORDER BY row_no LIMIT $3 OFFSET $4",
      [claims.workspaceId, importId, limit, offset],
    );
    return {
      total: (total.rows[0] as { n: number }).n,
      rows: rows.rows as ObservationView[],
    };
  });
}

// ---------------------------------------------------------------------------
// Parser child (terminable, credential-free): file bytes + profile in, typed
// result out. No DB/model credentials cross this boundary by construction.
// ---------------------------------------------------------------------------

export type ParserChildResult =
  | {
      ok: true;
      sheet: string | null;
      ignoredSheets: number;
      proposals: UploadProposal[];
      wallMs: number;
      heapUsedBytes: number;
    }
  | {
      ok: false;
      error: { code: UploadFileErrorCode; message: string };
      wallMs: number;
    };

export class ParserError extends Error {
  readonly transient: boolean;
  readonly code: string;
  constructor(code: string, transient: boolean, message?: string) {
    super(message ?? code);
    this.code = code;
    this.transient = transient;
  }
}

export async function runParserChild(opts: {
  parserChild: string;
  bytes: Uint8Array;
  filename: string;
  profile: UploadProfile;
  deadlineMs: number;
  hangMs?: number;
  limits?: { maxUploadBytes?: number; maxDecompressedBytes?: number; maxRows?: number; maxCols?: number; maxZipEntries?: number };
}): Promise<ParserChildResult> {
  let dir = "";
  try {
    dir = mkdtempSync(join(tmpdir(), "moneo-parse-"));
    const inFile = join(dir, "input.bin");
    const jobFile = join(dir, "job.json");
    const outFile = join(dir, "out.json");
    writeFileSync(inFile, Buffer.from(opts.bytes), { mode: 0o600 });
    writeFileSync(
      jobFile,
      JSON.stringify({
        file: inFile,
        filename: opts.filename,
        profile: opts.profile,
        out: outFile,
        ...(opts.limits === undefined ? {} : { limits: opts.limits }),
        ...(opts.hangMs === undefined ? {} : { hangMs: opts.hangMs }),
      }),
      { mode: 0o600 },
    );
    const child = spawn(process.execPath, ["--max-old-space-size=256", opts.parserChild, "--job", jobFile], { stdio: "ignore" });
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, opts.deadlineMs);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ code: null, signal: null });
      });
    });
    if (exit.signal === "SIGKILL" || exit.code === null) {
      throw new ParserError("timeout", true, `parser deadline exceeded after ${opts.deadlineMs} ms`);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(outFile, "utf8")) as Record<string, unknown>;
    } catch {
      throw new ParserError("internal", true, "parser produced no result");
    }
    if (parsed["ok"] === true) {
      return {
        ok: true,
        sheet: (parsed["sheet"] as string | null) ?? null,
        ignoredSheets: Number(parsed["ignoredSheets"] ?? 0),
        proposals: (parsed["proposals"] as UploadProposal[]) ?? [],
        wallMs: Number(parsed["wallMs"] ?? 0),
        heapUsedBytes: Number(parsed["heapUsedBytes"] ?? 0),
      };
    }
    const error = parsed["error"] as { code: UploadFileErrorCode; message: string };
    if (typeof error?.code !== "string") throw new ParserError("internal", true, "parser produced an unreadable result");
    return { ok: false, error: { code: error.code, message: String(error.message ?? "") }, wallMs: Number(parsed["wallMs"] ?? 0) };
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Parse processor: claim -> LOAD -> SCAN -> PARSE -> OBSERVE (deterministic
// chunks from the persisted checkpoint) -> terminal STAGED/REJECTED. Fenced
// per phase with the S02 machinery; cancel wins at the next boundary and
// publishes nothing afterwards. Exact terminal counts come from the stored
// rows, never from drum-rolled counters, so resume cannot drift them.
// ---------------------------------------------------------------------------

export type ProcessParseOutcome = "applied" | "deferred-transient" | "duplicate-terminal-noop";

type Route = JobRoute & { jobId: string };

async function terminalReject(
  client: PoolClient,
  route: Route,
  claim: Pick<Claim, "attemptId" | "generation">,
  importId: string,
  errorCode: string,
): Promise<void> {
  await client.query("UPDATE imports SET status = 'REJECTED', error_code = $3, completed_at = now(), staged_count = 0, review_count = 0, rejected_count = 0 WHERE workspace_id = $1 AND id = $2", [
    route.workspaceId,
    importId,
    errorCode,
  ]);
  await client.query(
    "UPDATE background_jobs SET status = 'SUCCEEDED', completed_at = now(), result_ref = $3, progress_stage = 'rejected', updated_at = now() WHERE workspace_id = $1 AND id = $2",
    [route.workspaceId, route.jobId, JSON.stringify({ importId, rejected: errorCode })],
  );
  await client.query(
    "INSERT INTO background_job_results (workspace_id, id, background_job_id, result_kind) VALUES ($1, $2, $3, 'import-parsed') ON CONFLICT (workspace_id, background_job_id) DO NOTHING",
    [route.workspaceId, uuidv7(), route.jobId],
  );
  await markAttempt(client, route, claim.attemptId, "SUCCEEDED");
  await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
}

function cellTooLarge(value: unknown): boolean {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_CELL_BYTES;
}

function proposalTooLarge(UploadProposal: UploadProposal): boolean {
  if (UploadProposal.kind === "accepted") {
    return cellTooLarge(UploadProposal.description) || cellTooLarge(UploadProposal.amountMinor) || cellTooLarge(UploadProposal.effectiveDate);
  }
  return Object.values(UploadProposal.kind === "needs_review" || UploadProposal.kind === "rejected" ? UploadProposal.raw : {}).some(cellTooLarge);
}

export async function processParseJob(
  pool: Pool,
  backgroundJobId: string,
  config: UploadConfig,
  opts?: { workerId?: string; leaseMs?: number; bullmqJobId?: string; limits?: Parameters<typeof runParserChild>[0]["limits"] },
): Promise<ProcessParseOutcome> {
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

  // LOAD: job input first (profile rides the durable input_ref), then the
  // quarantined object row. Bytes come from the object store next.
  const loaded = await fenced(async (client) => {
    const job = await client.query("SELECT input_ref FROM background_jobs WHERE workspace_id = $1 AND id = $2", [route.workspaceId, route.jobId]);
    const inputRef = (job.rows[0] as { input_ref: { importId: string; profile: UploadProfile } }).input_ref;
    const meta = await client.query(
      "SELECT object_key, size_bytes, sha256, status, (SELECT file_name FROM imports WHERE workspace_id = $1 AND id = $2) AS file_name, (SELECT parsed_rows FROM imports WHERE workspace_id = $1 AND id = $2) AS parsed_rows FROM source_objects WHERE workspace_id = $1 AND import_id = $2",
      [route.workspaceId, inputRef.importId],
    );
    if ((meta.rowCount ?? 0) === 0) throw new ParserError("internal", false, "source object missing");
    const row = meta.rows[0] as { object_key: string; file_name: string; sha256: string; parsed_rows: string };
    return { importId: inputRef.importId, profile: inputRef.profile, objectKey: row.object_key, sha: row.sha256, fileName: row.file_name, checkpoint: Number(row.parsed_rows) };
  });
  if (fencedOut(loaded)) return "duplicate-terminal-noop";
  assertQuarantineKey(loaded.objectKey);
  let bytes: Uint8Array;
  try {
    bytes = await s3Get(config.s3, loaded.objectKey, MAX_UPLOAD_BYTES + 1);
  } catch {
    // Object transport failure is transient: stay RUNNING for the sweep to
    // redeliver after the lease expires.
    return "deferred-transient";
  }
  if (sha256Hex(bytes) !== loaded.sha) {
    await fenced(async (client) => terminalReject(client, route, pick, loaded.importId, "object-mismatch"));
    return "applied";
  }

  // SCAN: dedicated malware verdict before any parse. INFECTED is a
  // permanent rejection: no observations, no promotion, no retry.
  const scanning = await fenced(async (client) => {
    await client.query("UPDATE imports SET status = 'SCANNING' WHERE workspace_id = $1 AND id = $2", [route.workspaceId, loaded.importId]);
    await client.query("UPDATE background_jobs SET progress_stage = 'scan', last_heartbeat_at = now() WHERE workspace_id = $1 AND id = $2", [
      route.workspaceId,
      route.jobId,
    ]);
    return true;
  });
  if (fencedOut(scanning)) return "duplicate-terminal-noop";
  let verdict;
  try {
    verdict = await clamdScan(config.clamav, bytes, config.scanTimeoutMs);
  } catch {
    return "deferred-transient";
  }
  if (!verdict.clean) {
    await fenced(async (client) => {
      await client.query("UPDATE source_objects SET status = 'INFECTED', scan_detail = $3, scanned_at = now() WHERE workspace_id = $1 AND import_id = $2", [
        route.workspaceId,
        loaded.importId,
        verdict.clean === false ? verdict.signature : "unknown",
      ]);
      await terminalReject(client, route, pick, loaded.importId, "malware-detected");
    });
    return "applied";
  }
  const parsing = await fenced(async (client) => {
    await client.query("UPDATE source_objects SET status = 'CLEAN', scanned_at = now() WHERE workspace_id = $1 AND import_id = $2", [
      route.workspaceId,
      loaded.importId,
    ]);
    await client.query("UPDATE imports SET status = 'PARSING' WHERE workspace_id = $1 AND id = $2", [route.workspaceId, loaded.importId]);
    await client.query("UPDATE background_jobs SET progress_stage = 'parsing', last_heartbeat_at = now() WHERE workspace_id = $1 AND id = $2", [
      route.workspaceId,
      route.jobId,
    ]);
    return true;
  });
  if (fencedOut(parsing)) return "duplicate-terminal-noop";

  // PARSE: terminable credential-free child. Timeout/crash is transient
  // (stay RUNNING for reclaim); typed parser failures are permanent.
  let proposals: UploadProposal[];
  try {
    const parsed = await runParserChild({
      parserChild: config.parserChild,
      bytes,
      filename: loaded.fileName,
      profile: loaded.profile,
      deadlineMs: 60_000,
      ...(opts?.limits === undefined ? {} : { limits: opts.limits }),
    });
    if (!parsed.ok) throw new ParserError(parsed.error.code, false, parsed.error.message);
    proposals = parsed.proposals;
  } catch (err) {
    if (err instanceof ParserError && !err.transient) {
      await fenced(async (client) => terminalReject(client, route, pick, loaded.importId, err.code));
      return "applied";
    }
    return "deferred-transient";
  }

  // OBSERVE: deterministic ≤1000-row chunks resumed from the persisted
  // checkpoint. INSERTs converge via (import,row) conflicts.
  for (let at = loaded.checkpoint; at < proposals.length; at += OBSERVE_CHUNK_ROWS) {
    const chunk = proposals.slice(at, at + OBSERVE_CHUNK_ROWS);
    const persisted = await fenced(async (client) => {
      for (const UploadProposal of chunk) {
        const tooLarge = proposalTooLarge(UploadProposal);
        if (UploadProposal.kind === "accepted" && !tooLarge) {
          await client.query(
            "INSERT INTO parsed_observations (workspace_id, import_id, row_no, status, observation_id, amount_minor, currency, direction, effective_date, description, source_sheet) VALUES ($1, $2, $3, 'STAGED', $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (workspace_id, import_id, row_no) DO NOTHING",
            [
              route.workspaceId,
              loaded.importId,
              UploadProposal.rowNumber,
              UploadProposal.observationId,
              UploadProposal.amountMinor,
              UploadProposal.currency,
              UploadProposal.direction,
              UploadProposal.effectiveDate,
              UploadProposal.description,
              UploadProposal.source.sheet,
            ],
          );
        } else {
          const reasons = UploadProposal.kind === "accepted" ? ["cell-limit"] : UploadProposal.reasons;
          const raw = UploadProposal.kind === "accepted" ? {} : UploadProposal.raw;
          await client.query(
            "INSERT INTO parsed_observations (workspace_id, import_id, row_no, status, observation_id, reasons, raw_cells, source_sheet) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (workspace_id, import_id, row_no) DO NOTHING",
            [
              route.workspaceId,
              loaded.importId,
              UploadProposal.rowNumber,
              UploadProposal.kind === "needs_review" ? "NEEDS_REVIEW" : "REJECTED",
              UploadProposal.observationId,
              JSON.stringify(reasons),
              JSON.stringify(raw),
              UploadProposal.source.sheet,
            ],
          );
        }
      }
      await client.query("UPDATE imports SET parsed_rows = $3 WHERE workspace_id = $1 AND id = $2", [route.workspaceId, loaded.importId, at + chunk.length]);
      await client.query("UPDATE background_jobs SET progress_stage = 'observe', last_heartbeat_at = now() WHERE workspace_id = $1 AND id = $2", [
        route.workspaceId,
        route.jobId,
      ]);
      return true;
    });
    if (fencedOut(persisted)) return "duplicate-terminal-noop";
  }

  // TERMINAL: exact counts reconciled from the stored rows (never from
  // replayable counters), staged import, immutable result marker, history,
  // index retirement — all under the re-asserted fence predicate.
  const done = await withTenant(pool, { userId: route.acceptedBy, workspaceId: route.workspaceId }, async (client) => {
    const guard = await fencedGuard(client, route, pick);
    if (!guard.ok) {
      await markAttempt(client, route, pick.attemptId, guard.reason === "cancelled" ? "CANCELLED" : "STALE");
      return guard;
    }
    const counts = await client.query(
      "SELECT status, count(*)::int AS n FROM parsed_observations WHERE workspace_id = $1 AND import_id = $2 GROUP BY status",
      [route.workspaceId, loaded.importId],
    );
    let rows = 0;
    let staged = 0;
    let review = 0;
    let rejected = 0;
    for (const row of counts.rows as { status: string; n: number }[]) {
      rows += row.n;
      if (row.status === "STAGED") staged = row.n;
      else if (row.status === "NEEDS_REVIEW") review = row.n;
      else rejected = row.n;
    }
    const terminal = await client.query(
      "UPDATE background_jobs SET status = 'SUCCEEDED', completed_at = now(), result_ref = $3, progress_stage = 'effect', updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'RUNNING' AND attempt_generation = $4 AND cancel_requested_at IS NULL",
      [route.workspaceId, route.jobId, JSON.stringify({ importId: loaded.importId, rows, staged, review, rejected }), pick.generation],
    );
    if ((terminal.rowCount ?? 0) !== 1) {
      await markAttempt(client, route, pick.attemptId, "STALE");
      return { ok: false as const, reason: "stale_attempt" as const };
    }
    await client.query(
      "UPDATE imports SET status = 'STAGED', completed_at = now(), row_count = $3, staged_count = $4, review_count = $5, rejected_count = $6 WHERE workspace_id = $1 AND id = $2",
      [route.workspaceId, loaded.importId, rows, staged, review, rejected],
    );
    await client.query("UPDATE source_objects SET status = 'ACCEPTED' WHERE workspace_id = $1 AND import_id = $2", [route.workspaceId, loaded.importId]);
    await client.query(
      "INSERT INTO background_job_results (workspace_id, id, background_job_id, result_kind) VALUES ($1, $2, $3, 'import-parsed') ON CONFLICT (workspace_id, background_job_id) DO NOTHING",
      [route.workspaceId, uuidv7(), route.jobId],
    );
    await markAttempt(client, route, pick.attemptId, "SUCCEEDED");
    await client.query("DELETE FROM job_dispatch_index WHERE workspace_id = $1 AND job_id = $2", [route.workspaceId, route.jobId]);
    return { ok: true as const };
  });
  return done.ok ? "applied" : "duplicate-terminal-noop";
}
