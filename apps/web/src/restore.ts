// E08-S02-L isolated restore with tombstone replay (architecture ##393,
// 463-464). Operator tooling (not an app route): pg_dump/pg_restore a
// disposable database into a FRESH isolated database, replay deletion
// tombstones newer than the restore point (the protected ledger lives
// outside restored data), verify exact financial evidence hashes, and leave
// traffic switching to the runbook checklist. Restores never touch the live
// database; corrupted backups fail closed. Production PITR/managed-state
// qualification is S02-D.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { s3Delete, s3DeleteExport, s3Get, s3GetExport, s3ListKeys, s3Put, s3PutExport, type S3Config } from "./s3.ts";

export type EvidenceHashes = Record<string, string>;

function pgBin(name: string): string {
  if (process.platform === "win32") {
    const dir = process.env["PG_BIN_DIR"] ?? "C:\\Program Files\\PostgreSQL\\18\\bin";
    return join(dir, `${name}.exe`);
  }
  return name;
}

type PgParts = { host: string; port: string; user: string; password: string; database: string };

function splitConnection(connectionString: string): PgParts {
  const u = new URL(connectionString);
  return {
    host: u.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: u.port || "5432",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
}

/** pg_dump custom format without secrets on argv (credentials via PG* env). */
export async function dumpDatabase(connectionString: string, outFile: string): Promise<{ bytes: number; ms: number }> {
  const parts = splitConnection(connectionString);
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      pgBin("pg_dump"),
      ["-Fc", "-f", outFile],
      {
        env: { ...process.env, PGHOST: parts.host, PGPORT: parts.port, PGUSER: parts.user, PGPASSWORD: parts.password, PGDATABASE: parts.database },
        timeout: 300_000,
      },
      (err) => (err ? reject(err) : resolve()),
    );
    child.on("error", reject);
  });
  const { size } = statSync(outFile);
  return { bytes: size, ms: Date.now() - started };
}

/** pg_restore into a target database (created beforehand, empty). The role option preserves application ownership (live objects are app-owned). */
export async function restoreDatabase(adminConnectionString: string, targetDatabase: string, dumpFile: string, opts?: { role?: string }): Promise<{ ms: number }> {
  const parts = splitConnection(adminConnectionString);
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      pgBin("pg_restore"),
      ["--clean", "--if-exists", "--no-owner", ...(opts?.role ? ["--role", opts.role] : []), "-d", targetDatabase, dumpFile],
      {
        env: { ...process.env, PGHOST: parts.host, PGPORT: parts.port, PGUSER: parts.user, PGPASSWORD: parts.password },
        timeout: 300_000,
      },
      (err) => (err ? reject(err) : resolve()),
    );
    child.on("error", reject);
  });
  return { ms: Date.now() - started };
}

function canon(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return `int:${value.toString()}`;
  if (Buffer.isBuffer(value)) return `bytes:${value.toString("hex")}`;
  if (value instanceof Date) return `time:${value.toISOString()}`;
  if (typeof value === "object") {
    const sorted = Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    return `json:${JSON.stringify(sorted, (_key, nested) => (typeof nested === "bigint" ? `int:${nested.toString()}` : nested))}`;
  }
  return `${typeof value}:${String(value)}`;
}

const EVIDENCE_SECTIONS: Array<{ name: string; sql: string }> = [
  { name: "transactions", sql: "SELECT id, account_id, amount_minor::text AS amount_minor, currency, direction, effective_date::text AS effective_date, description, category_id, version::text AS version, financial_kind FROM transactions WHERE workspace_id = $1 ORDER BY id" },
  { name: "manualTransactions", sql: "SELECT id, account_id, amount_minor::text AS amount_minor, currency, direction, effective_date::text AS effective_date, description, category_id, version::text AS version, financial_kind FROM manual_transactions WHERE workspace_id = $1 ORDER BY id" },
  { name: "balanceSnapshots", sql: "SELECT id, account_id, as_of_date::text AS as_of_date, amount_minor::text AS amount_minor, currency, source, freshness FROM balance_snapshots WHERE workspace_id = $1 ORDER BY id" },
  { name: "fxManualRates", sql: "SELECT rate_date::text AS rate_date, base_currency, target_currency, rate, auditor, source FROM fx_rates_manual WHERE workspace_id = $1 ORDER BY rate_date, base_currency, target_currency" },
  { name: "goals", sql: "SELECT id, name, goal_type, status, target_amount_minor::text AS target_amount_minor, currency_code, version::text AS version FROM goals WHERE workspace_id = $1 ORDER BY id" },
  { name: "goalAllocations", sql: "SELECT id, goal_id, account_id, allocation_type, amount_minor::text AS amount_minor, currency_code FROM goal_allocations WHERE workspace_id = $1 ORDER BY id" },
  { name: "artifacts", sql: "SELECT id, name, description, active_version_id FROM artifacts WHERE workspace_id = $1 ORDER BY id" },
  { name: "artifactVersions", sql: "SELECT id, artifact_id, manifest, encode(source_hash, 'hex') AS source_hash, encode(build_hash, 'hex') AS build_hash, status, source_html, source_css, source_js FROM artifact_versions WHERE workspace_id = $1 ORDER BY id" },
  { name: "artifactState", sql: "SELECT artifact_id, version_id, schema_version, state FROM artifact_state WHERE workspace_id = $1 ORDER BY artifact_id" },
  { name: "savedAnalyses", sql: "SELECT id, status, data_revision, policy_version, report FROM deep_analysis_runs WHERE workspace_id = $1 ORDER BY id" },
  { name: "savedAnalysisFindings", sql: "SELECT id, run_id, kind, title, body, amount_minor, currency FROM deep_analysis_findings WHERE workspace_id = $1 ORDER BY id" },
];

/** Canonical SHA-256 evidence hashes per section (exact decimal strings, deterministic order, no floats). */
export async function hashWorkspaceEvidence(pool: Pool, workspaceId: string): Promise<EvidenceHashes> {
  const out: EvidenceHashes = {};
  for (const section of EVIDENCE_SECTIONS) {
    const found = await pool.query(section.sql, [workspaceId]);
    const lines = (found.rows as Record<string, unknown>[]).map((row) =>
      Object.entries(row)
        .map(([k, v]) => `${k}=${canon(v)}`)
        .join("|"),
    );
    out[section.name] = createHash("sha256").update(lines.join("\n")).digest("hex");
  }
  return out;
}

export function diffEvidence(expected: EvidenceHashes, actual: EvidenceHashes): string[] {
  const mismatches: string[] = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (expected[key] !== actual[key]) mismatches.push(key);
  }
  return mismatches;
}

export type TombstoneInput = {
  subjectKind: "workspace" | "identity";
  subjectRef: string;
  workspaceRef: string | null;
  successorUserId: string | null;
  scope: string;
  requestId: string;
  deletedAt: string;
};

export type ReplayResult = { applied: number; skipped: number; needsExternalIdentity: string[] };

/**
 * Replay tombstones newer than the restore point into the restored database
 * (operator pool bypasses RLS; every statement stays workspace-scoped).
 * Workspace scope re-purges the resurrected workspace row (cascade) plus its
 * objects; identity scope removes the resurrected membership, sessions and
 * personal content and anonymizes the identity only with zero memberships
 * anywhere. External IdP deletion cannot run here: subjects needing it are
 * reported for the runbook step.
 */
export async function replayTombstones(admin: Pool, s3: S3Config, tombstones: TombstoneInput[], restorePointIso: string): Promise<ReplayResult> {
  const result: ReplayResult = { applied: 0, skipped: 0, needsExternalIdentity: [] };
  const restorePoint = new Date(restorePointIso).getTime();
  for (const tomb of tombstones) {
    if (!Number.isFinite(new Date(tomb.deletedAt).getTime()) || new Date(tomb.deletedAt).getTime() <= restorePoint) {
      result.skipped += 1;
      continue;
    }
    if (tomb.subjectKind === "workspace") {
      // Mirror the S01b purge list for rows the workspace cascade cannot
      // reach: proposals (no workspace FK), both expiry indexes, and member
      // sessions (revoked after capturing subs — the members row is going).
      const memberSubs = await admin.query("SELECT u.auth_subject FROM users u JOIN workspace_members m ON m.user_id = u.id WHERE m.workspace_id = $1", [tomb.subjectRef]);
      await admin.query("DELETE FROM workspaces WHERE id = $1", [tomb.subjectRef]);
      await purgeWorkspaceObjects(admin, s3, tomb.subjectRef);
      await admin.query("DELETE FROM ai_action_proposals WHERE workspace_id = $1", [tomb.subjectRef]);
      await admin.query("DELETE FROM import_expiry_index WHERE workspace_id = $1", [tomb.subjectRef]);
      await admin.query("DELETE FROM export_expiry_index WHERE workspace_id = $1", [tomb.subjectRef]);
      for (const row of memberSubs.rows as Array<{ auth_subject: string }>) {
        if (row.auth_subject && !row.auth_subject.startsWith("deleted:")) {
          await admin.query("UPDATE app_sessions SET revoked_at = now() WHERE keycloak_sub = $1 AND revoked_at IS NULL", [row.auth_subject]);
        }
      }
      result.applied += 1;
      continue;
    }
    if (tomb.subjectKind === "identity" && tomb.workspaceRef) {
      const ws = tomb.workspaceRef;
      const sub = tomb.subjectRef;
      if (tomb.successorUserId) {
        const promoted = await admin.query("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2 RETURNING user_id", [ws, tomb.successorUserId]);
        if ((promoted.rowCount ?? 0) !== 1) throw new Error("restore successor missing");
      }
      await admin.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [ws, sub]);
      const subRow = await admin.query("SELECT auth_subject FROM users WHERE id = $1", [sub]);
      const authSub = (subRow.rows[0] as { auth_subject: string } | undefined)?.auth_subject ?? "";
      if (authSub && !authSub.startsWith("deleted:")) {
        await admin.query("UPDATE app_sessions SET revoked_at = now() WHERE keycloak_sub = $1 AND revoked_at IS NULL", [authSub]);
      }
      const threads = await admin.query("SELECT id FROM chat_threads WHERE workspace_id = $1 AND created_by = $2", [ws, sub]);
      const threadIds = (threads.rows as Array<{ id: string }>).map((r) => r.id);
      if (threadIds.length > 0) {
        await admin.query("DELETE FROM chat_activity WHERE workspace_id = $1 AND thread_id = ANY ($2)", [ws, threadIds]);
        await admin.query("DELETE FROM chat_turns WHERE workspace_id = $1 AND thread_id = ANY ($2)", [ws, threadIds]);
        await admin.query("DELETE FROM chat_threads WHERE workspace_id = $1 AND id = ANY ($2)", [ws, threadIds]);
      }
      await admin.query("DELETE FROM notices WHERE workspace_id = $1 AND user_id = $2", [ws, sub]);
      await admin.query("DELETE FROM artifact_runtime_grants WHERE workspace_id = $1 AND user_id = $2", [ws, sub]);
      const pkgs = await admin.query("SELECT id, object_key FROM export_packages WHERE workspace_id = $1 AND requested_by = $2", [ws, sub]);
      const purgedPackageIds: string[] = [];
      for (const row of pkgs.rows as Array<{ id: string; object_key: string | null }>) {
        if (row.object_key) {
          try {
            await s3DeleteExport(s3, row.object_key);
          } catch { throw new Error("restore export purge failed"); }
        }
        await admin.query("DELETE FROM export_packages WHERE workspace_id = $1 AND id = $2", [ws, row.id]);
        purgedPackageIds.push(row.id);
      }
      if (purgedPackageIds.length > 0) {
        await admin.query("DELETE FROM export_expiry_index WHERE workspace_id = $1 AND package_id = ANY ($2)", [ws, purgedPackageIds]);
      }
      await admin.query("DELETE FROM ai_action_proposals WHERE workspace_id = $1 AND (proposed_by = $2 OR confirmed_by = $2)", [ws, sub]);
      const remaining = await admin.query("SELECT 1 FROM workspace_members WHERE user_id = $1 LIMIT 1", [sub]);
      if ((remaining.rowCount ?? 0) === 0 && authSub && !authSub.startsWith("deleted:")) {
        await admin.query("UPDATE users SET auth_subject = $2 WHERE id = $1", [sub, `deleted:${tomb.requestId}`]);
        result.needsExternalIdentity.push(authSub);
      }
      result.applied += 1;
      continue;
    }
    result.skipped += 1;
  }
  return result;
}

async function purgeWorkspaceObjects(admin: Pool, s3: S3Config, workspaceId: string): Promise<void> {
  for (const prefix of [`exports/${workspaceId}/`, `quarantine/${workspaceId}/`]) {
    const keys = await s3ListKeys(s3, prefix, 1000);
    for (const key of keys) {
      if (key.startsWith("exports/")) await s3DeleteExport(s3, key);
      else await s3Delete(s3, key);
    }
  }
  await admin.query("DELETE FROM source_objects WHERE workspace_id = $1", [workspaceId]);
  await admin.query("DELETE FROM export_packages WHERE workspace_id = $1", [workspaceId]);
}

/** Snapshot a workspace's objects to a local directory (bytes + key manifest). */
export async function snapshotWorkspaceObjects(s3: S3Config, workspaceId: string, dir: string): Promise<{ files: number; bytes: number }> {
  mkdirSync(dir, { recursive: true });
  const manifest: Array<{ key: string; file: string }> = [];
  let bytes = 0;
  let n = 0;
  for (const prefix of [`exports/${workspaceId}/`, `quarantine/${workspaceId}/`]) {
    const kind = prefix.startsWith("exports/") ? "exports" : "quarantine";
    const keys = await s3ListKeys(s3, prefix, 1000);
    for (const key of keys) {
      const data = key.startsWith("exports/") ? await s3GetExport(s3, key, 64 * 1024 * 1024) : await s3Get(s3, key, 100 * 1024 * 1024);
      const file = `${kind}-${n}.bin`;
      writeFileSync(join(dir, file), Buffer.from(data));
      manifest.push({ key, file });
      bytes += data.byteLength;
      n += 1;
    }
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return { files: manifest.length, bytes };
}

/** Restore objects from a snapshot directory; returns byte-identical failures. Manifest entries are validated (basename files, known prefixes) so a tampered manifest cannot traverse or overwrite foreign keys. */
export async function restoreWorkspaceObjects(s3: S3Config, dir: string): Promise<{ restored: number; mismatched: string[] }> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Array<{ key: string; file: string }>;
  let restored = 0;
  const mismatched: string[] = [];
  for (const entry of manifest) {
    if (typeof entry.key !== "string" || typeof entry.file !== "string") throw new Error("restore manifest refused");
    if (entry.file.includes("/") || entry.file.includes("\\") || entry.file.includes("..")) throw new Error("restore manifest refused");
    if (!/^exports\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.enc$/.test(entry.key) && !/^quarantine\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(entry.key)) {
      throw new Error("restore manifest refused");
    }
  }
  for (const entry of manifest) {
    const bytes = new Uint8Array(readFileSync(join(dir, entry.file)));
    if (entry.key.startsWith("exports/")) await s3PutExport(s3, entry.key, bytes, "application/octet-stream");
    else await s3Put(s3, entry.key, bytes, "text/csv");
    const back = entry.key.startsWith("exports/") ? await s3GetExport(s3, entry.key, 64 * 1024 * 1024) : await s3Get(s3, entry.key, 100 * 1024 * 1024);
    if (Buffer.from(back).equals(Buffer.from(bytes))) restored += 1;
    else mismatched.push(entry.key);
  }
  return { restored, mismatched };
}

export function drillTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}
