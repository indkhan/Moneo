// E08-S01 workspace export: step-up-gated accept, fenced encrypted build,
// exact-money/CSV-safe package contents, private-conversation exclusion,
// one-use download, expiry, cancel/retry and tenant isolation. Real
// disposable PostgreSQL (`moneo_e08_export`, fails closed), real Redis
// (dedicated logical DB 10, loopback-guarded; only this DB is ever flushed)
// and real MinIO (loopback, disposable bucket, `exports/` prefix isolated at
// suite start). Synthetic users/workspaces/finance only.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { Queue } from "bullmq";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
import { dispatchOutbox, jobsQueue, type JobPayload } from "../apps/web/src/jobs.ts";
import { csvCell, loadExportConfig, processExportJob, type ExportConfig } from "../apps/web/src/export.ts";
import { s3DeleteExport, s3EnsureBucket, s3GetExport, s3ListKeys } from "../apps/web/src/s3.ts";
import { ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

const MEMBER2_SENTINEL = "member2-private-sentinel-9z8x";
const OWNER_SENTINEL = "owner-thread-sentinel-7q6w";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
let redisUrl: string;
let queue: Queue<JobPayload>;
let config: ExportConfig;
const savedEnv: Record<string, string | undefined> = {};

function exportRedisUrl(): string {
  const base = env("E08-S01", "REDIS_URL");
  const u = new URL(base);
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("E08-S01 refused: REDIS_URL must point at the local disposable Redis.");
  }
  const db = process.env["EXPORT_REDIS_DB"] ?? "10";
  if (!/^\d+$/.test(db) || Number(db) < 0 || Number(db) > 15) throw new Error("E08-S01 misconfigured: EXPORT_REDIS_DB must be 0-15.");
  u.pathname = `/${db}`;
  return u.toString();
}

async function startApp(): Promise<string> {
  const authConfig: AuthConfig = {
    issuer: stub.base,
    clientId: STUB_CLIENT_ID,
    clientSecret: STUB_CLIENT_SECRET,
    appBaseUrl: "http://127.0.0.1:1",
    sessionSecret,
    sessionTtlSec: 43200,
  };
  const uiBase = "http://127.0.0.1:1";
  const server = createApp(
    createAuthRouter(authConfig, pool),
    createTenancyRouter(pool, (req) => requestSession(pool, sessionSecret, req)),
    { ui: createUiRouter(pool, (req) => requestSession(pool, sessionSecret, req), { appBaseUrl: uiBase, sessionSecret }) },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  appServers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  authConfig.appBaseUrl = base;
  return base;
}

async function login(base: string, loginAs: string): Promise<string> {
  const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const authorizeUrl = `${start.headers.get("location")!}&login_as=${loginAs}`;
  const callbackUrl = (await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!;
  const done = await fetch(callbackUrl, { redirect: "manual" });
  return done.headers.get("set-cookie")!.split(";")[0];
}

async function setupWorkspace(base: string, sub: string): Promise<{ cookie: string; workspaceId: string; userId: string }> {
  const cookie = await login(base, sub);
  const ws = (await (
    await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ExportW", baseCurrency: "EUR" }),
    })
  ).json()) as { id: string };
  const userRow = await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub]);
  return { cookie, workspaceId: ws.id, userId: (userRow.rows[0] as { id: string }).id };
}

async function addMember(owner: { userId: string; workspaceId: string }, sub: string): Promise<{ userId: string }> {
  const setup = await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub]);
  let userId: string;
  if ((setup.rowCount ?? 0) === 0) {
    const created = await pool.query("INSERT INTO users (id, auth_subject) VALUES ($1, $2) RETURNING id", [randomUUID(), sub]);
    userId = (created.rows[0] as { id: string }).id;
  } else {
    userId = (setup.rows[0] as { id: string }).id;
  }
  await withTenant(pool, { userId: owner.userId, workspaceId: owner.workspaceId }, async (client) => {
    await client.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING", [owner.workspaceId, userId]);
  });
  return { userId };
}

function scoped<T>(userId: string, workspaceId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(pool, { userId, workspaceId }, work);
}

/** Seed a deterministic finance+content fixture; returns independent oracle values. */
async function seedFixture(userId: string, workspaceId: string, tag: string): Promise<{ accountId: string; importId: string }> {
  return scoped(userId, workspaceId, async (client) => {
    const accountId = randomUUID();
    await client.query("INSERT INTO accounts (workspace_id, id, name, version, base_currency_code, archived, source) VALUES ($1, $2, $3, 1, 'EUR', false, 'manual')", [
      workspaceId,
      accountId,
      `${tag}-checking`,
    ]);
    const dsId = randomUUID();
    await client.query("INSERT INTO data_sources (workspace_id, id, type, name, status) VALUES ($1, $2, 'csv_upload', $3, 'ACTIVE')", [workspaceId, dsId, `${tag}-bank`]);
    const importId = randomUUID();
    await client.query(
      "INSERT INTO imports (workspace_id, id, data_source_id, idempotency_key, file_name, file_sha256, object_key, parser_version, status, parsed_rows, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'proof-import-1', 'STAGED', 2, now() + interval '30 days')",
      [workspaceId, importId, dsId, randomUUID(), `${tag}-statement.csv`, "ab".repeat(32), `quarantine/${workspaceId}/${randomUUID()}`],
    );
    // Exact-money oracle rows incl. a beyond-safe-integer amount + hostile CSV descriptions.
    await client.query(
      "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id, version, financial_kind) VALUES ($1, $2, $3, 250000, 'EUR', 'INFLOW', '2024-01-02', 'Salary January', $4, 2, 'obs-1', 1, 'NORMAL'), ($1, $5, $3, 9007199254740993, 'EUR', 'OUTFLOW', '2024-01-03', '=1+1 hostile formula', $4, 3, 'obs-2', 1, 'NORMAL')",
      [workspaceId, randomUUID(), accountId, importId, randomUUID()],
    );
    await client.query(
      "INSERT INTO manual_transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, actor_id, version, financial_kind) VALUES ($1, $2, $3, 1225, 'EUR', 'OUTFLOW', '2024-01-04', '@malicious mention', $4, 1, 'NORMAL')",
      [workspaceId, randomUUID(), accountId, userId],
    );
    await client.query(
      "INSERT INTO balance_snapshots (workspace_id, id, account_id, as_of_date, amount_minor, currency, source, provenance, freshness, reconciliation_state) VALUES ($1, $2, $3, '2024-01-31', 9007199254992218, 'EUR', 'manual', '{}', 'current', 'unreconciled')",
      [workspaceId, randomUUID(), accountId],
    );
    await client.query("INSERT INTO goals (workspace_id, id, name, goal_type, status, target_amount_minor, currency_code, version) VALUES ($1, $2, $3, 'SAVINGS_TARGET', 'ACTIVE', 500000, 'EUR', 1)", [
      workspaceId,
      randomUUID(),
      `${tag}-goal`,
    ]);
    const artifactId = randomUUID();
    await client.query("INSERT INTO artifacts (workspace_id, id, name) VALUES ($1, $2, $3)", [workspaceId, artifactId, `${tag}-chart`]);
    const versionId = randomUUID();
    await client.query(
      "INSERT INTO artifact_versions (workspace_id, id, artifact_id, manifest, source_hash, build_hash, status, source_html, source_css, source_js) VALUES ($1, $2, $3, '{\"schema\":1}', '\\x00', '\\x01', 'ready', '<div>hi</div>', '', 'render();')",
      [workspaceId, versionId, artifactId],
    );
    await client.query("INSERT INTO artifact_state (workspace_id, artifact_id, version_id, schema_version, state) VALUES ($1, $2, $3, 1, '{\"tab\":\"full\"}')", [
      workspaceId,
      artifactId,
      versionId,
    ]);
    const runId = randomUUID();
    await client.query(
      "INSERT INTO deep_analysis_runs (workspace_id, id, status, attempt_count, data_revision, policy_version, window_started_at, commit_ids, dispatches_used, tool_calls_used, tokens_reserved, cost_reserved_minor, progress_stage, coverage_warnings, report) VALUES ($1, $2, 'SUCCEEDED', 1, 'rev-1', '1', now(), '[]', 1, 0, 100, '4', 'done', '[]', '{\"summary\":\"ok\"}')",
      [workspaceId, runId],
    );
    await client.query("INSERT INTO deep_analysis_findings (workspace_id, id, run_id, kind, title, body, amount_minor, currency, evidence) VALUES ($1, $2, $3, 'spending', 'Food', 'At most 100', '7550', 'EUR', '[]')", [
      workspaceId,
      randomUUID(),
      runId,
    ]);
    return { accountId, importId };
  });
}

async function seedThread(userId: string, workspaceId: string, title: string, body: string): Promise<void> {
  await scoped(userId, workspaceId, async (client) => {
    const threadId = randomUUID();
    await client.query("INSERT INTO chat_threads (workspace_id, id, title, status, created_by) VALUES ($1, $2, $3, 'open', $4)", [workspaceId, threadId, title, userId]);
    await client.query("INSERT INTO chat_turns (workspace_id, id, thread_id, role, status, body) VALUES ($1, $2, $3, 'user', 'completed', $4)", [
      workspaceId,
      randomUUID(),
      threadId,
      body,
    ]);
  });
}

async function acceptExport(base: string, cookie: string, workspaceId: string, key?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/exports`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey: key ?? randomUUID() }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function runExport(jobId: string): Promise<string> {
  await dispatchOutbox(pool, queue);
  return processExportJob(pool, jobId, config.s3);
}

async function readPackage(base: string, cookie: string, workspaceId: string, packageId: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/exports/${packageId}`, { headers: { cookie } });
  return { status: res.status, json: (await res.json()) as any };
}

async function downloadPackage(base: string, cookie: string, workspaceId: string, packageId: string): Promise<{ status: number; bytes: Buffer; text: string }> {
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/exports/${packageId}/download`, { headers: { cookie } });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes, text: bytes.toString("utf8") };
}

beforeAll(async () => {
  for (const name of ["EXPORTS_ENABLED", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET", "EXPORT_REDIS_DB"]) {
    savedEnv[name] = process.env[name];
  }
  pool = await ensureTestPool("E08-S01", "moneo_e08_export", [
    "export_packages",
    "background_job_attempts",
    "job_dispatch_index",
    "outbox_events",
    "background_job_results",
    "background_jobs",
    "command_operations",
    "parsed_observations",
    "review_decisions",
    "source_links",
    "transactions",
    "manual_transactions",
    "balance_snapshots",
    "balance_audit",
    "imports",
    "data_sources",
    "import_commit_batches",
    "goals",
    "goal_allocations",
    "artifacts",
    "artifact_versions",
    "artifact_state",
    "artifact_state_snapshots",
    "deep_analysis_runs",
    "deep_analysis_findings",
    "chat_turns",
    "chat_threads",
    "audit_events",
    "notices",
    "accounts",
    "workspace_members",
    "workspaces",
    "users",
    "app_sessions",
  ]);
  stub = await startStubIssuer();
  for (const name of ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"]) {
    if (!process.env[name]) process.env[name] = env("E08-S01", name);
  }
  process.env["EXPORTS_ENABLED"] = "1";
  if (!process.env["S3_ENDPOINT"]) process.env["S3_ENDPOINT"] = "http://127.0.0.1:9000";
  if (!process.env["S3_REGION"]) process.env["S3_REGION"] = "us-east-1";
  config = loadExportConfig();
  await s3EnsureBucket(config.s3);
  const leftovers = await s3ListKeys(config.s3, "exports/");
  for (const key of leftovers) {
    await s3DeleteExport(config.s3, key);
  }
  redisUrl = exportRedisUrl();
  queue = jobsQueue(redisUrl);
  await queue.waitUntilReady();
  await queue.obliterate({ force: true });
}, 120_000);

afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (queue) await queue.close();
  if (pool) await pool.end();
});

describe("e08-s01 export unit guards", () => {
  it("csvCell neutralizes formula-leading cells only", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@mention")).toBe("'@mention");
    expect(csvCell("  =indirect")).toBe("'  =indirect");
    expect(csvCell("Salary January")).toBe("Salary January");
    expect(csvCell("100")).toBe("100");
    expect(csvCell("AT&T")).toBe("AT&T");
  });
});

describe("e08-s01 workspace export", () => {
  it("accept builds an encrypted exact package and one-use download serves it", async () => {
    const base = await startApp();
    const owner = await setupWorkspace(base, "synthetic-export-owner-a");
    const member = await addMember(owner, "synthetic-export-member-a");
    const memberCookie = await login(base, "synthetic-export-member-a");
    await seedFixture(owner.userId, owner.workspaceId, "alpha");
    await seedThread(owner.userId, owner.workspaceId, "owner thread", OWNER_SENTINEL);
    await seedThread(member.userId, owner.workspaceId, "member thread", MEMBER2_SENTINEL);

    const accepted = await acceptExport(base, owner.cookie, owner.workspaceId);
    expect(accepted.status).toBe(202);
    expect(accepted.json.package.status).toBe("BUILDING");
    const packageId = accepted.json.packageId as string;
    const jobId = accepted.json.jobId as string;

    expect(await runExport(jobId)).toBe("applied");
    const ready = await readPackage(base, owner.cookie, owner.workspaceId, packageId);
    expect(ready.status).toBe(200);
    expect(ready.json.package.status).toBe("READY");
    expect(ready.json.package.sectionCounts.transactions).toBe(2);
    expect(ready.json.package.sectionCounts.manualTransactions).toBe(1);
    expect(ready.json.package.manifest.format).toBe("moneo-export/1");

    // The object store holds ciphertext only: no sentinel, no money text.
    const keys = await s3ListKeys(config.s3, `exports/${owner.workspaceId}/`);
    expect(keys.length).toBe(1);
    const rawBytes = Buffer.from(await s3GetExport(config.s3, keys[0], 64 * 1024 * 1024)).toString("latin1");
    expect(rawBytes).not.toContain(OWNER_SENTINEL);
    expect(rawBytes).not.toContain(MEMBER2_SENTINEL);
    expect(rawBytes).not.toContain("9007199254740993");

    const first = await downloadPackage(base, owner.cookie, owner.workspaceId, packageId);
    expect(first.status).toBe(200);
    const envelope = JSON.parse(first.text) as any;
    expect(envelope.format).toBe("moneo-export/1");
    // Exact money incl. beyond-safe-integer value as decimal strings.
    const txRows: string[] = envelope.csv.transactions.split("\n");
    expect(txRows[0]).toBe("id,source,account_id,date,description,amount_minor,currency,direction,import_id");
    expect(txRows.some((r) => r.includes(",9007199254740993,EUR,OUTFLOW,"))).toBe(true);
    expect(txRows.some((r) => r.includes("'=1+1 hostile formula"))).toBe(true);
    expect(txRows.some((r) => r.includes("'@malicious mention"))).toBe(true);
    expect(envelope.data.balanceSnapshots[0].amount_minor).toBe("9007199254992218");
    // Owner content present; member private content excluded.
    expect(JSON.stringify(envelope.data.conversationTurns)).toContain(OWNER_SENTINEL);
    expect(JSON.stringify(envelope)).not.toContain(MEMBER2_SENTINEL);
    expect(envelope.data.activity).toEqual([]);
    // Artifact source/state + saved analyses present; secrets never.
    expect(envelope.data.artifactVersions[0].source_js).toContain("render();");
    expect(JSON.parse(envelope.data.savedAnalyses[0].report)).toMatchObject({ summary: "ok" });
    expect(first.text).not.toContain("S3_SECRET_KEY");
    expect(envelope.data.workspace[0].name).toBe("ExportW");

    // One-use: the second download is a uniform 404.
    const second = await downloadPackage(base, owner.cookie, owner.workspaceId, packageId);
    expect(second.status).toBe(404);
    // Download audit is attributable activity.
    await scoped(owner.userId, owner.workspaceId, async (client) => {
      const audit = await client.query("SELECT action FROM audit_events WHERE workspace_id = $1 AND entity_type = 'export_package' AND entity_id = $2", [
        owner.workspaceId,
        packageId,
      ]);
      expect(audit.rowCount).toBe(1);
      expect((audit.rows[0] as { action: string }).action).toBe("downloaded");
    });
  });

  it("replay converges to one package; concurrent accepts create one job", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-export-replay-a");
    await seedFixture(me.userId, me.workspaceId, "beta");
    const key = randomUUID();
    const [first, second] = await Promise.all([acceptExport(base, me.cookie, me.workspaceId, key), acceptExport(base, me.cookie, me.workspaceId, key)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 202]);
    const winner = first.status === 202 ? first : second;
    const replay = first.status === 200 ? first : second;
    expect(replay.json.packageId).toBe(winner.json.packageId);
    expect(replay.json.replayed).toBe(true);
    await scoped(me.userId, me.workspaceId, async (client) => {
      const jobs = await client.query("SELECT count(*)::int AS n FROM background_jobs WHERE workspace_id = $1 AND job_type = 'exports.build'", [me.workspaceId]);
      expect((jobs.rows[0] as { n: number }).n).toBe(1);
    });
    expect(await runExport(winner.json.jobId)).toBe("applied");
  });

  it("scales to the story fixture: 10k transactions and 2 artifacts in one package", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-export-scale-a");
    const seeded = await seedFixture(me.userId, me.workspaceId, "kappa");
    await scoped(me.userId, me.workspaceId, async (client) => {
      await client.query(
        "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id, version, financial_kind) SELECT $1, ('00000000-0000-4000-8000-' || lpad(to_hex(s), 12, '0'))::uuid, $2, 100 + s, 'EUR', CASE WHEN s % 2 = 0 THEN 'INFLOW' ELSE 'OUTFLOW' END, '2024-02-01', 'bulk-' || s, $3, s + 100, 'bulk-obs-' || s, 1, 'NORMAL' FROM generate_series(1, 10000) s",
        [me.workspaceId, seeded.accountId, seeded.importId],
      );
      for (const n of ["kappa-extra-1", "kappa-extra-2"]) {
        const artifactId = randomUUID();
        await client.query("INSERT INTO artifacts (workspace_id, id, name) VALUES ($1, $2, $3)", [me.workspaceId, artifactId, n]);
        await client.query("INSERT INTO artifact_versions (workspace_id, id, artifact_id, manifest, source_hash, build_hash, status, source_html, source_css, source_js) VALUES ($1, $2, $3, '{}', '\\x00', '\\x01', 'ready', '', '', '')", [
          me.workspaceId,
          randomUUID(),
          artifactId,
        ]);
      }
    });
    const accepted = await acceptExport(base, me.cookie, me.workspaceId);
    expect(accepted.status).toBe(202);
    const started = Date.now();
    expect(await runExport(accepted.json.jobId)).toBe("applied");
    const elapsedMs = Date.now() - started;
    const ready = await readPackage(base, me.cookie, me.workspaceId, accepted.json.packageId);
    expect(ready.json.package.status).toBe("READY");
    expect(ready.json.package.sectionCounts.transactions).toBe(10002);
    expect(ready.json.package.sectionCounts.artifacts).toBe(3);
    // Local reference measurement only (host-sensitive; not a host SLA).
    expect(elapsedMs).toBeLessThan(120_000);
  });

  it("expired idempotency keys conflict and busy workspaces refuse a second key", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-export-busy-a");
    await seedFixture(me.userId, me.workspaceId, "gamma");
    const key = randomUUID();
    const first = await acceptExport(base, me.cookie, me.workspaceId, key);
    expect(first.status).toBe(202);
    // Second distinct key while one export is active: workspace_busy.
    const busy = await acceptExport(base, me.cookie, me.workspaceId);
    expect(busy.status).toBe(409);
    expect(busy.json).toEqual({ error: "conflict", reason: "workspace_busy" });
    // Backdate the first operation past 30-day replay retention: expired.
    await scoped(me.userId, me.workspaceId, async (client) => {
      await client.query("UPDATE command_operations SET expires_at = now() - interval '1 minute' WHERE workspace_id = $1 AND idempotency_key = $2", [
        me.workspaceId,
        key,
      ]);
    });
    const expired = await acceptExport(base, me.cookie, me.workspaceId, key);
    expect(expired.status).toBe(409);
    expect(expired.json).toEqual({ error: "conflict", reason: "idempotency_expired" });
  });

  it("missing or stale step-up fails closed on accept and download", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-export-stepup-a");
    await seedFixture(me.userId, me.workspaceId, "delta");
    // Missing provider claims: login succeeds but export is denied.
    stub.setStepUp("missing");
    const weakCookie = await login(base, "synthetic-export-stepup-weak");
    await addMember(me, "synthetic-export-stepup-weak");
    const weakDenied = await acceptExport(base, weakCookie, me.workspaceId);
    expect(weakDenied.status).toBe(403);
    expect(weakDenied.json).toEqual({ error: "forbidden", reason: "step_up_required" });
    // auth_time without acr is not a step-up: the acr claim is required too.
    stub.setStepUp("no-acr");
    const noAcrCookie = await login(base, "synthetic-export-stepup-noacr");
    await addMember(me, "synthetic-export-stepup-noacr");
    const noAcrDenied = await acceptExport(base, noAcrCookie, me.workspaceId);
    expect(noAcrDenied.status).toBe(403);
    expect(noAcrDenied.json).toEqual({ error: "forbidden", reason: "step_up_required" });
    stub.setStepUp("ok");
    // Stale step-up: backdate the session claim; both doors deny.
    await pool.query("UPDATE app_sessions SET step_up_at = now() - interval '10 minutes' WHERE keycloak_sub = $1", ["synthetic-export-stepup-a"]);
    const staleAccept = await acceptExport(base, me.cookie, me.workspaceId);
    expect(staleAccept.status).toBe(403);
    // Fresh login restores access; then backdate again for the download door.
    const freshCookie = await login(base, "synthetic-export-stepup-a");
    const accepted = await acceptExport(base, freshCookie, me.workspaceId);
    expect(accepted.status).toBe(202);
    expect(await runExport(accepted.json.jobId)).toBe("applied");
    await pool.query("UPDATE app_sessions SET step_up_at = now() - interval '10 minutes' WHERE keycloak_sub = $1", ["synthetic-export-stepup-a"]);
    const staleDownload = await downloadPackage(base, freshCookie, me.workspaceId, accepted.json.packageId);
    expect(staleDownload.status).toBe(403);
  });

  it("foreign, revoked and missing ids are uniform 404s with no bytes", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "synthetic-export-tenant-a");
    const b = await setupWorkspace(base, "synthetic-export-tenant-b");
    await seedFixture(a.userId, a.workspaceId, "epsilon");
    const accepted = await acceptExport(base, a.cookie, a.workspaceId);
    expect(await runExport(accepted.json.jobId)).toBe("applied");
    const packageId = accepted.json.packageId as string;
    // Foreign workspace reads: uniform 404.
    expect((await readPackage(base, b.cookie, b.workspaceId, packageId)).status).toBe(404);
    expect((await downloadPackage(base, b.cookie, b.workspaceId, packageId)).status).toBe(404);
    // Cross-workspace id confusion: B's own workspace with A's package id.
    expect((await readPackage(base, b.cookie, a.workspaceId, packageId)).status).toBe(404);
    // Missing id: identical body.
    const missing = randomUUID();
    const m = await readPackage(base, a.cookie, a.workspaceId, missing);
    expect(m.status).toBe(404);
    expect(m.json).toEqual({ error: "not_found" });
    // Revoked member loses access identically.
    await scoped(a.userId, a.workspaceId, async (client) => {
      const row = await pool.query("SELECT id FROM users WHERE auth_subject = 'synthetic-export-tenant-a'", []);
      await client.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [a.workspaceId, (row.rows[0] as { id: string }).id]);
    });
    expect((await readPackage(base, a.cookie, a.workspaceId, packageId)).status).toBe(404);
    // Unscoped app-role reads return zero rows (FORCE RLS).
    const bare = await pool.query("SELECT count(*)::int AS n FROM export_packages");
    expect((bare.rows[0] as { n: number }).n).toBe(0);
  });

  it("download storage failure reopens the single use without audit residue", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-export-reopen-a");
    await seedFixture(me.userId, me.workspaceId, "lambda");
    const accepted = await acceptExport(base, me.cookie, me.workspaceId);
    expect(await runExport(accepted.json.jobId)).toBe("applied");
    const packageId = accepted.json.packageId as string;
    // Simulate a lost object after READY: the consume succeeds, the fetch
    // fails, and the package must reopen with no download recorded.
    const keys = await s3ListKeys(config.s3, `exports/${me.workspaceId}/`);
    expect(keys.length).toBe(1);
    await s3DeleteExport(config.s3, keys[0]);
    const failed = await downloadPackage(base, me.cookie, me.workspaceId, packageId);
    expect(failed.status).toBe(404);
    await scoped(me.userId, me.workspaceId, async (client) => {
      const pkg = await client.query("SELECT downloaded_at FROM export_packages WHERE workspace_id = $1 AND id = $2", [me.workspaceId, packageId]);
      expect((pkg.rows[0] as { downloaded_at: string | null }).downloaded_at).toBeNull();
      const audit = await client.query("SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = $1 AND entity_type = 'export_package' AND entity_id = $2 AND action = 'downloaded'", [
        me.workspaceId,
        packageId,
      ]);
      expect((audit.rows[0] as { n: number }).n).toBe(0);
    });
  });

  it("member exports contain only their own conversations", async () => {
    const base = await startApp();
    const owner = await setupWorkspace(base, "synthetic-export-mine-owner");
    const member = await addMember(owner, "synthetic-export-mine-member");
    const memberCookie = await login(base, "synthetic-export-mine-member");
    await seedFixture(owner.userId, owner.workspaceId, "zeta");
    await seedThread(owner.userId, owner.workspaceId, "owner thread", OWNER_SENTINEL);
    await seedThread(member.userId, owner.workspaceId, "member thread", MEMBER2_SENTINEL);
    const accepted = await acceptExport(base, memberCookie, owner.workspaceId);
    expect(accepted.status).toBe(202);
    expect(await runExport(accepted.json.jobId)).toBe("applied");
    const dl = await downloadPackage(base, memberCookie, owner.workspaceId, accepted.json.packageId);
    expect(dl.status).toBe(200);
    expect(dl.text).toContain(MEMBER2_SENTINEL);
    expect(dl.text).not.toContain(OWNER_SENTINEL);
  });

  it("expiry removes the object once and cancel converges without effects", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-export-expiry-a");
    await seedFixture(me.userId, me.workspaceId, "eta");
    const accepted = await acceptExport(base, me.cookie, me.workspaceId);
    expect(await runExport(accepted.json.jobId)).toBe("applied");
    const packageId = accepted.json.packageId as string;
    // Member-triggered expiry deletes the object and nulls the keys.
    const expireRes = await fetch(`${base}/api/workspaces/${me.workspaceId}/exports/${packageId}/expire`, {
      method: "POST",
      headers: { cookie: me.cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(expireRes.status).toBe(200);
    expect(((await expireRes.json()) as any).expired).toBe(true);
    expect(await s3ListKeys(config.s3, `exports/${me.workspaceId}/`)).toEqual([]);
    const after = await readPackage(base, me.cookie, me.workspaceId, packageId);
    expect(after.json.package.status).toBe("EXPIRED");
    expect((await downloadPackage(base, me.cookie, me.workspaceId, packageId)).status).toBe(404);
    // Repeat expiry is idempotent.
    const again = await fetch(`${base}/api/workspaces/${me.workspaceId}/exports/${packageId}/expire`, {
      method: "POST",
      headers: { cookie: me.cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(((await again.json()) as any).expired).toBe(true);
    // Cancel before claim converges with no published package.
    const pending = await acceptExport(base, me.cookie, me.workspaceId);
    expect(pending.status).toBe(202);
    const cancelRes = await fetch(`${base}/api/workspaces/${me.workspaceId}/exports/${pending.json.packageId}/cancel`, {
      method: "POST",
      headers: { cookie: me.cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(cancelRes.status).toBe(200);
    expect(((await cancelRes.json()) as any).status).toBe("CANCELLED");
    expect(await runExport(pending.json.jobId)).toBe("duplicate-terminal-noop");
    const cancelled = await readPackage(base, me.cookie, me.workspaceId, pending.json.packageId);
    expect(cancelled.json.package.status).toBe("FAILED_FINAL");
    // Lazy expiry on read: backdate a READY package and read it.
    const fresh = await acceptExport(base, me.cookie, me.workspaceId);
    expect(await runExport(fresh.json.jobId)).toBe("applied");
    await scoped(me.userId, me.workspaceId, async (client) => {
      await client.query("UPDATE export_packages SET expires_at = now() - interval '1 minute' WHERE workspace_id = $1 AND id = $2", [me.workspaceId, fresh.json.packageId]);
    });
    const lazy = await readPackage(base, me.cookie, me.workspaceId, fresh.json.packageId);
    expect(lazy.json.package.status).toBe("EXPIRED");
    expect(await s3ListKeys(config.s3, `exports/${me.workspaceId}/`)).toEqual([]);
  });

  it("failed storage is retryable: no package publishes until the object lands", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-export-retry-a");
    await seedFixture(me.userId, me.workspaceId, "theta");
    const accepted = await acceptExport(base, me.cookie, me.workspaceId);
    const badS3 = { ...config.s3, endpoint: "http://127.0.0.1:9" };
    await dispatchOutbox(pool, queue);
    await expect(processExportJob(pool, accepted.json.jobId, badS3, { leaseMs: 150 })).rejects.toThrow();
    const still = await readPackage(base, me.cookie, me.workspaceId, accepted.json.packageId);
    expect(still.json.package.status).toBe("BUILDING");
    // The failed attempt's short lease expires; the next delivery reclaims and converges.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await runExport(accepted.json.jobId)).toBe("applied");
    const ready = await readPackage(base, me.cookie, me.workspaceId, accepted.json.packageId);
    expect(ready.json.package.status).toBe("READY");
  });

  it("privacy page requests, lists and downloads with keyboard-safe markup", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-export-ui-a");
    await seedFixture(me.userId, me.workspaceId, "iota");
    const pageRes = await fetch(`${base}/w/${me.workspaceId}/privacy`, { headers: { cookie: me.cookie } });
    expect(pageRes.status).toBe(200);
    const pageText = await pageRes.text();
    expect(pageText).toContain("Privacy &amp; Security");
    expect(pageText).toContain("Request workspace export");
    expect(pageText).toContain("30 days");
    expect(pageText).not.toContain("<script");
    // Form POST requests the export (303), then the package lists.
    const form = new URLSearchParams({ idempotencyKey: randomUUID() });
    const posted = await fetch(`${base}/w/${me.workspaceId}/privacy`, {
      method: "POST",
      headers: { cookie: me.cookie, "Content-Type": "application/x-www-form-urlencoded", origin: base },
      body: form.toString(),
      redirect: "manual",
    });
    expect(posted.status).toBe(303);
    const listed = await (await fetch(`${base}/w/${me.workspaceId}/privacy`, { headers: { cookie: me.cookie } })).text();
    expect(listed).toContain("BUILDING");
    // Unauthenticated visitors get the login landing, not data.
    const anon = await fetch(`${base}/w/${me.workspaceId}/privacy`);
    expect(anon.status).toBe(200);
    const anonText = await anon.text();
    expect(anonText).toContain("Log in");
    expect(anonText).not.toContain("Request workspace export");
  });

  it("exports hide as 404 when disabled", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-export-disabled-a");
    delete process.env["EXPORTS_ENABLED"];
    try {
      const res = await fetch(`${base}/api/workspaces/${me.workspaceId}/exports`, {
        method: "POST",
        headers: { cookie: me.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: randomUUID() }),
      });
      expect(res.status).toBe(404);
    } finally {
      process.env["EXPORTS_ENABLED"] = "1";
    }
  });
});
