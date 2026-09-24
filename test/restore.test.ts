// E08-S02-L isolated restore with tombstone replay: pg_dump/pg_restore a
// disposable database into a FRESH isolated database, replay newer
// tombstones, verify exact evidence hashes, fail closed on corruption, and
// re-run migrations + boot. Real pg_dump/pg_restore binaries, real MinIO,
// synthetic data only. Durations are asserted loosely here and recorded
// exactly in STORIES.md; they are local measurements, not host promises.

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { withTenant } from "../apps/web/src/tenancy.ts";
import { migrate, withDatabase } from "../apps/web/src/db.ts";
import { acceptDeletion, listTombstones } from "../apps/web/src/deletion.ts";
import {
  cleanTempDir,
  diffEvidence,
  drillTempDir,
  dumpDatabase,
  hashWorkspaceEvidence,
  replayTombstones,
  restoreDatabase,
  restoreWorkspaceObjects,
  snapshotWorkspaceObjects,
  type EvidenceHashes,
  type TombstoneInput,
} from "../apps/web/src/restore.ts";
import { s3EnsureBucket, s3ListKeys, s3Put, type S3Config } from "../apps/web/src/s3.ts";
import { ensureTestMigrationPool, ensureTestPool, env } from "./helpers/test-db.ts";
import type { Session } from "../apps/web/src/session-store.ts";

const LIVE_DB = "moneo_e08_restore";
const ISO_DB = "moneo_e08_restore_iso";
const BAD_DB = "moneo_e08_restore_bad";

let pool: Pool;
let adminLive: Pool;
let adminIso: Pool;
let isoAppPool: Pool;
const appServers: Server[] = [];
let s3: S3Config;
let drillDir = "";
let measured: Record<string, number> = {};
const savedEnv: Record<string, string | undefined> = {};

function isoUrl(dbName: string): string {
  return withDatabase(env("E08-S02-L", "DATABASE_MIGRATION_URL"), dbName);
}

async function freshSession(sub: string): Promise<Session> {
  const id = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  await pool.query("INSERT INTO app_sessions (id, keycloak_sub, expires_at, step_up_at, step_up_acr) VALUES ($1, $2, now() + interval '12 hours', now(), '1')", [id, sub]);
  return { id, keycloakSub: sub, createdAt: now, expiresAt: now, stepUpAt: now, stepUpAcr: "1" };
}

async function setupUser(sub: string): Promise<{ userId: string }> {
  const found = await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub]);
  if ((found.rowCount ?? 0) > 0) return { userId: (found.rows[0] as { id: string }).id };
  const created = await pool.query("INSERT INTO users (id, auth_subject) VALUES ($1, $2) RETURNING id", [randomUUID(), sub]);
  return { userId: (created.rows[0] as { id: string }).id };
}

async function setupWorkspace(userId: string, name: string): Promise<string> {
  const wsId = randomUUID();
  await adminLive.query("INSERT INTO workspaces (id, name, base_currency_code) VALUES ($1, $2, 'EUR')", [wsId, name]);
  await adminLive.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [wsId, userId]);
  return wsId;
}

async function addMember(ownerId: string, workspaceId: string, sub: string): Promise<{ userId: string }> {
  const member = await setupUser(sub);
  await withTenant(pool, { userId: ownerId, workspaceId }, async (client) => {
    await client.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING", [workspaceId, member.userId]);
  });
  return member;
}

/** Seed finance + content + one real object; all exact-money oracle rows. */
async function seedWorkspace(userId: string, workspaceId: string, tag: string): Promise<{ objectKey: string }> {
  const objectKey = `quarantine/${workspaceId}/${randomUUID()}`;
  await s3Put(s3, objectKey, new TextEncoder().encode(`${tag}-bytes`), "text/csv");
  await withTenant(pool, { userId, workspaceId }, async (client) => {
    const accountId = randomUUID();
    await client.query("INSERT INTO accounts (workspace_id, id, name, version, base_currency_code, archived, source) VALUES ($1, $2, $3, 1, 'EUR', false, 'manual')", [workspaceId, accountId, `${tag}-checking`]);
    const dsId = randomUUID();
    await client.query("INSERT INTO data_sources (workspace_id, id, type, name, status) VALUES ($1, $2, 'csv_upload', $3, 'ACTIVE')", [workspaceId, dsId, `${tag}-bank`]);
    const importId = randomUUID();
    await client.query(
      "INSERT INTO imports (workspace_id, id, data_source_id, idempotency_key, file_name, file_sha256, object_key, parser_version, status, parsed_rows, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'proof-import-1', 'STAGED', 2, now() + interval '30 days')",
      [workspaceId, importId, dsId, randomUUID(), `${tag}.csv`, "ab".repeat(32), objectKey],
    );
    await client.query("INSERT INTO source_objects (workspace_id, id, import_id, object_key, size_bytes, sha256, status) VALUES ($1, $2, $3, $4, 11, $5, 'ACCEPTED')", [
      workspaceId, randomUUID(), importId, objectKey, "cd".repeat(32),
    ]);
    await client.query(
      "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id, version, financial_kind) VALUES ($1, $2, $3, 250000, 'EUR', 'INFLOW', '2024-01-02', 'Salary', $4, 2, 'obs-1', 1, 'NORMAL'), ($1, $5, $3, 9007199254740993, 'EUR', 'OUTFLOW', '2024-01-03', 'Big outflow', $4, 3, 'obs-2', 1, 'NORMAL')",
      [workspaceId, randomUUID(), accountId, importId, randomUUID()],
    );
    await client.query(
      "INSERT INTO manual_transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, actor_id, version, financial_kind) VALUES ($1, $2, $3, 1225, 'EUR', 'OUTFLOW', '2024-01-04', 'Cash', $4, 1, 'NORMAL')",
      [workspaceId, randomUUID(), accountId, userId],
    );
    await client.query("INSERT INTO balance_snapshots (workspace_id, id, account_id, as_of_date, amount_minor, currency, source, provenance, freshness, reconciliation_state) VALUES ($1, $2, $3, '2024-01-31', 9007199254992218, 'EUR', 'manual', '{}', 'current', 'unreconciled')", [
      workspaceId, randomUUID(), accountId,
    ]);
    await client.query("INSERT INTO fx_rates_manual (workspace_id, rate_date, base_currency, target_currency, rate, auditor, source) VALUES ($1, '2024-01-15', 'EUR', 'USD', '1.09', 'test', 'manual')", [workspaceId]);
    await client.query("INSERT INTO goals (workspace_id, id, name, goal_type, status, target_amount_minor, currency_code, version) VALUES ($1, $2, $3, 'SAVINGS_TARGET', 'ACTIVE', 500000, 'EUR', 1)", [
      workspaceId, randomUUID(), `${tag}-goal`,
    ]);
    const artifactId = randomUUID();
    await client.query("INSERT INTO artifacts (workspace_id, id, name) VALUES ($1, $2, $3)", [workspaceId, artifactId, `${tag}-chart`]);
    const versionId = randomUUID();
    await client.query("INSERT INTO artifact_versions (workspace_id, id, artifact_id, manifest, source_hash, build_hash, status, source_html, source_css, source_js) VALUES ($1, $2, $3, '{}', '\\x00', '\\x01', 'ready', '<div>x</div>', '', 'go();')", [
      workspaceId, versionId, artifactId,
    ]);
    await client.query("INSERT INTO artifact_state (workspace_id, artifact_id, version_id, schema_version, state) VALUES ($1, $2, $3, 1, '{}')", [workspaceId, artifactId, versionId]);
    const runId = randomUUID();
    await client.query("INSERT INTO deep_analysis_runs (workspace_id, id, status, attempt_count, data_revision, policy_version, window_started_at, commit_ids, dispatches_used, tool_calls_used, tokens_reserved, cost_reserved_minor, progress_stage, coverage_warnings, report) VALUES ($1, $2, 'SUCCEEDED', 1, 'rev-1', '1', now(), '[]', 1, 0, 100, '4', 'done', '[]', '{\"ok\":true}')", [
      workspaceId, runId,
    ]);
    await client.query("INSERT INTO deep_analysis_findings (workspace_id, id, run_id, kind, title, body, amount_minor, currency, evidence) VALUES ($1, $2, $3, 'spending', 'Food', 'At most 100', '7550', 'EUR', '[]')", [
      workspaceId, randomUUID(), runId,
    ]);
  });
  return { objectKey };
}

beforeAll(async () => {
  for (const name of ["DELETIONS_ENABLED", "EXPORTS_ENABLED", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"]) {
    savedEnv[name] = process.env[name];
  }
  pool = await ensureTestPool("E08-S02-L", LIVE_DB, [
    "import_expiry_index", "export_expiry_index", "deletion_tombstones", "deletion_requests", "export_packages",
    "background_job_attempts", "job_dispatch_index", "outbox_events", "background_job_results", "background_jobs",
    "command_operations", "parsed_observations", "review_decisions", "source_links", "transactions", "manual_transactions",
    "balance_snapshots", "balance_audit", "imports", "data_sources", "source_objects", "import_commit_batches",
    "goals", "goal_allocations", "artifacts", "artifact_versions", "artifact_state", "artifact_state_snapshots",
    "deep_analysis_runs", "deep_analysis_findings", "chat_turns", "chat_threads", "audit_events", "notices",
    "fx_rates_manual", "accounts", "workspace_members", "workspaces", "users", "app_sessions",
  ]);
  adminLive = await ensureTestMigrationPool("E08-S02-L", LIVE_DB);
  for (const name of ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"]) {
    if (!process.env[name]) process.env[name] = env("E08-S02-L", name);
  }
  if (!process.env["S3_ENDPOINT"]) process.env["S3_ENDPOINT"] = "http://127.0.0.1:9000";
  if (!process.env["S3_REGION"]) process.env["S3_REGION"] = "us-east-1";
  process.env["DELETIONS_ENABLED"] = "1";
  process.env["EXPORTS_ENABLED"] = "1";
  const { loadExportConfig } = await import("../apps/web/src/export.ts");
  s3 = loadExportConfig().s3;
  await s3EnsureBucket(s3);
  drillDir = drillTempDir("moneo-restore-drill-");
}, 120_000);

afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
  if (adminLive) await adminLive.end();
  if (adminIso) await adminIso.end();
  if (isoAppPool) await isoAppPool.end();
  if (drillDir) cleanTempDir(drillDir);
});

describe("e08-s02-L isolated restore with tombstone replay", () => {
  it("restores exact evidence, replays newer tombstones, fails closed on corruption", async () => {    // Seed: KEEP survives everything; DEL1 (workspace purge) and DEL2/M2
    // (identity purge) die after the backup.
    const keep = await setupUser("synthetic-restore-keep");
    const keepWs = await setupWorkspace(keep.userId, "keep");
    const keepSeed = await seedWorkspace(keep.userId, keepWs, "keep");
    const d1 = await setupUser("synthetic-restore-del1");
    const del1Ws = await setupWorkspace(d1.userId, "del1");
    await seedWorkspace(d1.userId, del1Ws, "del1");
    const o2 = await setupUser("synthetic-restore-o2");
    const del2Ws = await setupWorkspace(o2.userId, "del2");
    await seedWorkspace(o2.userId, del2Ws, "del2");
    const m2 = await addMember(o2.userId, del2Ws, "synthetic-restore-m2");

    const preHashes: EvidenceHashes = await hashWorkspaceEvidence(adminLive, keepWs);
    // Live sessions pre-backup (revocation replay needs them in the dump).
    const d1Session = await freshSession("synthetic-restore-del1");
    const m2Session = await freshSession("synthetic-restore-m2");
    // B2/N3 fixture: proposal + expiry rows the cascade cannot reach, a KEEP
    // export for the two-prefix snapshot, and a pre-T0 tombstone (skipped).
    await adminLive.query(
      "INSERT INTO ai_action_proposals (workspace_id, id, kind, payload_hash, payload, account_version, policy_version, proposed_by, status, idempotency_key, expires_at) VALUES ($1, $2, 'create_manual_transaction', $3, $4, 1, 1, $5, 'proposed', $6, now() + interval '1 hour'), ($7, $8, 'create_manual_transaction', $3, $4, 1, 1, $9, 'proposed', $10, now() + interval '1 hour')",
      [del1Ws, randomUUID(), "ab".repeat(32), JSON.stringify({ accountId: randomUUID(), amountMinor: "100", currency: "EUR", direction: "OUTFLOW", effectiveDate: "2024-01-02", description: "x" }), d1.userId, randomUUID(), del2Ws, randomUUID(), m2.userId, randomUUID()],
    );
    await adminLive.query("INSERT INTO import_expiry_index (workspace_id, import_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [
      del1Ws, randomUUID(),
    ]);
    const { acceptExportJob, processExportJob, loadExportConfig } = await import("../apps/web/src/export.ts");
    const keepExport = await acceptExportJob(pool, { userId: keep.userId, workspaceId: keepWs }, keep.userId, await freshSession("synthetic-restore-keep"), {
      workspaceId: keepWs, idempotencyKey: randomUUID(),
    });
    expect(await processExportJob(pool, keepExport.jobId, loadExportConfig().s3)).toBe("applied");
    const snap = await snapshotWorkspaceObjects(s3, keepWs, `${drillDir}/keep-objects`);
    expect(snap.files).toBe(2);
    // Pre-T0 tombstone for a dead subject: must skip, never apply.
    const oldTombSubject = randomUUID();
    await adminLive.query("INSERT INTO deletion_tombstones (id, subject_kind, subject_ref, scope, request_id, basis, deleted_at) VALUES ($1, 'workspace', $2, 'workspace', $3, 'erasure-request', now() - interval '1 hour')", [
      randomUUID(), oldTombSubject, randomUUID(),
    ]);



    // Restore point + backup (before the deletions).
    const t0 = new Date().toISOString();
    const dumpFile = `${drillDir}/live-backup.dump`;
    const dumped = await dumpDatabase(withDatabase(env("E08-S02-L", "DATABASE_MIGRATION_URL"), LIVE_DB), dumpFile);
    expect(dumped.bytes).toBeGreaterThan(0);



    // Real S01b deletions after the backup (tombstones newer than T0).
    const del1Res = await acceptDeletion(pool, { userId: d1.userId, workspaceId: del1Ws }, d1.userId, d1Session, { workspaceId: del1Ws, scope: "workspace", idempotencyKey: randomUUID() });
    expect(del1Res.view.status).toBe("COMPLETE");
    const del2Res = await acceptDeletion(pool, { userId: m2.userId, workspaceId: del2Ws }, m2.userId, m2Session, { workspaceId: del2Ws, scope: "identity", idempotencyKey: randomUUID() });
    expect(del2Res.view.status).toBe("COMPLETE");



    // The protected ledger copy (outside restored data).
    const ledger = await listTombstones(pool);
    const ledgerInputs: TombstoneInput[] = ledger.map((t) => ({
      subjectKind: t.subjectKind as "workspace" | "identity",
      subjectRef: t.subjectRef,
      workspaceRef: t.workspaceRef,
      scope: t.scope,
      requestId: t.requestId,
      deletedAt: t.deletedAt,
    }));
    expect(ledgerInputs.filter((t) => new Date(t.deletedAt).getTime() > new Date(t0).getTime()).length).toBe(2);

    // Disaster drill target: FRESH isolated database, live untouched.


    await adminLive.query(`DROP DATABASE IF EXISTS "${ISO_DB}"`);
    await adminLive.query(`CREATE DATABASE "${ISO_DB}"`);
    adminIso = new Pool({ connectionString: isoUrl(ISO_DB), connectionTimeoutMillis: 8000 });
    isoAppPool = new Pool({ connectionString: withDatabase(env("E08-S02-L", "DATABASE_URL"), ISO_DB) });
    // Operator grants: application ownership + schema create, mirroring how
    // live drill databases are provisioned (see the runbook).
    const appRole = decodeURIComponent(new URL(env("E08-S02-L", "DATABASE_URL")).username);
    if (!/^[A-Za-z_][A-Za-z0-9_@$]*$/.test(appRole)) throw new Error("E08-S02-L refused: app-role username is not a safe SQL identifier.");
    await adminIso.query(`ALTER DATABASE "${ISO_DB}" OWNER TO "${appRole}"`);
    await adminIso.query(`GRANT CREATE ON SCHEMA public TO "${appRole}"`);
    // Preserve application ownership like the live database (operator step).
    const restored = await restoreDatabase(env("E08-S02-L", "DATABASE_MIGRATION_URL"), ISO_DB, dumpFile, { role: appRole });


    // Resurrection proven: pre-delete DEL1 rows are back in the raw restore.
    const resurrected = await adminIso.query("SELECT count(*)::int AS n FROM workspaces WHERE id = $1", [del1Ws]);
    expect((resurrected.rows[0] as { n: number }).n).toBe(1);

    // Replay tombstones newer than T0 before any traffic (the pre-T0 dead
    // subject skips).
    const replayStarted = Date.now();
    const replayed = await replayTombstones(adminIso, s3, ledgerInputs, t0);
    measured = { dumpMs: dumped.ms, dumpBytes: dumped.bytes, restoreMs: restored.ms, replayMs: Date.now() - replayStarted, snapshotFiles: snap.files, snapshotBytes: snap.bytes };
    expect(replayed.applied).toBe(2);
    expect(replayed.skipped).toBe(1);
    expect(replayed.needsExternalIdentity).toEqual(["synthetic-restore-m2"]);

    // KEEP evidence is byte-exact; DEL scopes are re-purged with objects.
    const postHashes = await hashWorkspaceEvidence(adminIso, keepWs);
    expect(diffEvidence(preHashes, postHashes)).toEqual([]);
    expect((await adminIso.query("SELECT count(*)::int AS n FROM workspaces WHERE id = $1", [del1Ws])).rows[0]).toEqual({ n: 0 });
    expect((await adminIso.query("SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [del2Ws, m2.userId])).rows[0]).toEqual({ n: 0 });
    const m2Anon = await adminIso.query("SELECT auth_subject FROM users WHERE id = $1", [m2.userId]);
    expect((m2Anon.rows[0] as { auth_subject: string }).auth_subject.startsWith("deleted:")).toBe(true);
    // B2/N3 negative paths: no-cascade leftovers are re-purged, DEL2 objects
    // survive, the remaining owner is untouched.
    expect((await adminIso.query("SELECT count(*)::int AS n FROM ai_action_proposals WHERE workspace_id IN ($1, $2)", [del1Ws, del2Ws])).rows[0]).toEqual({ n: 0 });
    expect((await adminIso.query("SELECT count(*)::int AS n FROM import_expiry_index WHERE workspace_id = $1", [del1Ws])).rows[0]).toEqual({ n: 0 });
    expect((await adminIso.query("SELECT count(*)::int AS n FROM export_expiry_index WHERE workspace_id = $1", [del2Ws])).rows[0]).toEqual({ n: 0 });
    expect((await adminIso.query("SELECT count(*)::int AS n FROM app_sessions WHERE revoked_at IS NULL AND keycloak_sub = 'synthetic-restore-del1'")).rows[0]).toEqual({ n: 0 });
    expect((await adminIso.query("SELECT auth_subject FROM users WHERE id = $1", [o2.userId])).rows[0]).toEqual({ auth_subject: "synthetic-restore-o2" });
    expect((await s3ListKeys(s3, `quarantine/${del2Ws}/`)).length).toBe(1);
    expect(await s3ListKeys(s3, `quarantine/${del1Ws}/`)).toEqual([]);
    expect((await s3ListKeys(s3, `quarantine/${keepWs}/`)).length).toBe(1);
    // Object round-trip from the snapshot: delete, restore, byte-compare.
    const { s3Delete } = await import("../apps/web/src/s3.ts");
    await s3Delete(s3, keepSeed.objectKey);
    const reloaded = await restoreWorkspaceObjects(s3, `${drillDir}/keep-objects`);
    expect(reloaded.mismatched).toEqual([]);
    expect(reloaded.restored).toBe(snap.files);

    // Migrations re-run cleanly on the restored tree; the app boots and a
    // tenant read works against the isolated database.
    expect(await migrate(adminIso, "apps/web/migrations")).toEqual([]);
    const server = createApp(null, null, { dbPing: () => adminIso.query("SELECT 1").then(() => true) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    appServers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await (await fetch(`${base}/healthz`)).json()) as { status: string }).toMatchObject({ status: "ok" });
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    const tenantReadPool = isoAppPool;
    const tenantRead = await withTenant(
      tenantReadPool,
      { userId: keep.userId, workspaceId: keepWs },
      async (client) => client.query("SELECT count(*)::int AS n FROM accounts WHERE workspace_id = $1", [keepWs]),
    );
    expect((tenantRead.rows[0] as { n: number }).n).toBe(1);

    // Corrupted backup fails closed into a scratch database.
    await adminLive.query(`DROP DATABASE IF EXISTS "${BAD_DB}"`);
    await adminLive.query(`CREATE DATABASE "${BAD_DB}"`);
    const corruptFile = `${drillDir}/corrupt.dump`;
    writeFileSync(corruptFile, readFileSync(dumpFile).subarray(0, 100));
    await expect(restoreDatabase(env("E08-S02-L", "DATABASE_MIGRATION_URL"), BAD_DB, corruptFile)).rejects.toThrow();
    // A missing dump file rejects immediately (never hangs on stdin).
    await expect(restoreDatabase(env("E08-S02-L", "DATABASE_MIGRATION_URL"), BAD_DB, `${drillDir}/no-such.dump`)).rejects.toThrow();
    const badPool = new Pool({ connectionString: isoUrl(BAD_DB) });
    try {
      // A truncated custom-format dump dies reading the TOC: either the
      // table was never created (42P01) or it holds zero rows.
      let leftover = -1;
      try {
        const tables = await badPool.query("SELECT count(*)::int AS n FROM transactions");
        leftover = (tables.rows[0] as { n: number }).n;
      } catch {
        leftover = 0;
      }
      expect(leftover).toBe(0);
    } finally {
      await badPool.end();
    }

    // Live was never the restore target: KEEP evidence there is untouched.
    expect(diffEvidence(preHashes, await hashWorkspaceEvidence(adminLive, keepWs))).toEqual([]);
    // Loose local bounds (host-sensitive; exact values recorded in STORIES.md).
    expect(measured.dumpMs).toBeLessThan(300_000);
    expect(measured.restoreMs).toBeLessThan(300_000);
    // Evidence file for the ledger (approved temp dir, never committed).
    writeFileSync("C:\\Users\\mgsuk\\AppData\\Local\\Temp\\opencode\\restore-measure.json", JSON.stringify({ ...measured, t0 }));
  }, 300_000);
});
