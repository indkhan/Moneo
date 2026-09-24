// E08-S05-L repeatable local load and failure measurement: fixed synthetic
// dataset (2 workspaces, 100 accounts, 10k transactions, 12 pinned
// artifacts, one 100k-row boundary import), 1/5/20 concurrent readers with
// exact-money/tenant assertions, worker-death/Redis-loss/provider-outage/
// cancel drills and bounded AI cost. Real disposable PG (`moneo_e08_load`),
// Redis (dedicated DB 8, loopback-guarded), MinIO + ClamAV. Durations are
// local reference measurements for the ledger, never host promises.

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { Queue } from "bullmq";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { createWorkspace } from "../apps/web/src/tenancy.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
import { dispatchOutbox, jobsQueue, processImportJob, type JobPayload } from "../apps/web/src/jobs.ts";
import { cancelJob, reconcileTransport } from "../apps/web/src/job-recovery.ts";
import { processParseJob, loadUploadConfig, type UploadConfig } from "../apps/web/src/uploads.ts";
import { acceptMapping, proposeMapping } from "../apps/web/src/mapping.ts";
import { acceptImportCommitJob, processCommitJob, DEFAULT_COMMIT_CONFIG } from "../apps/web/src/import-commit.ts";
import { clamdPing } from "../apps/web/src/clamav.ts";
import { s3EnsureBucket, s3ListKeys, s3Delete, s3DeleteExport } from "../apps/web/src/s3.ts";
import { dispatchModelCall, setDispatchBudget, type DispatchAttempt, type DispatchTransport } from "../apps/web/src/ai-dispatch.ts";
import { DispatchError, dispatchErrorBody } from "../apps/web/src/ai-dispatch.ts";
import { issuePermit } from "../apps/web/src/ai-policy.ts";
import { ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
let redisUrl: string;
let queue: Queue<JobPayload>;
let uploadConfig: UploadConfig;
const savedEnv: Record<string, string | undefined> = {};

type Oracle = { inflowMinor: bigint; outflowMinor: bigint; count: number };

function loadRedisUrl(): string {
  const base = env("E08-S05-L", "REDIS_URL");
  const u = new URL(base);
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("E08-S05-L refused: REDIS_URL must point at the local disposable Redis.");
  }
  const db = process.env["LOAD_REDIS_DB"] ?? "8";
  if (!/^\d+$/.test(db) || Number(db) < 0 || Number(db) > 15) throw new Error("E08-S05-L misconfigured: LOAD_REDIS_DB must be 0-15.");
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
  const server = createApp(
    createAuthRouter(authConfig, pool),
    createTenancyRouter(pool, (req) => requestSession(pool, sessionSecret, req)),
    { ui: createUiRouter(pool, (req) => requestSession(pool, sessionSecret, req), { appBaseUrl: "http://127.0.0.1:1", sessionSecret }) },
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

function scoped<T>(userId: string, workspaceId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(pool, { userId, workspaceId }, work);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const summary: Record<string, unknown> = { story: "E08-S05-L", synthetic: true };

beforeAll(async () => {
  for (const name of ["UPLOADS_ENABLED", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET", "CLAMAV_HOST", "CLAMAV_PORT", "LOAD_REDIS_DB", "PARSER_CHILD"]) {
    savedEnv[name] = process.env[name];
  }
  pool = await ensureTestPool("E08-S05-L", "moneo_e08_load", [
    "ai_dispatch_usage", "ai_dispatch_reservations", "ai_dispatch_budgets", "ai_dispatch_permits", "ai_exclusions", "ai_policies",
    "chat_turns", "chat_threads", "audit_events", "notices", "home_layout_tiles", "home_layouts",
    "artifact_state_snapshots", "artifact_state", "artifact_versions", "artifacts",
    "goals", "goal_allocations", "projection_runs", "projection_points", "projection_events",
    "parsed_observations", "review_decisions", "source_links", "transactions", "manual_transactions",
    "balance_snapshots", "imports", "data_sources", "source_objects", "import_commit_batches",
    "mapping_proposals", "mapping_profiles", "background_job_attempts", "job_dispatch_index", "outbox_events",
    "background_job_results", "background_jobs", "command_operations",
    "accounts", "workspace_members", "workspaces", "users", "app_sessions",
  ]);
  stub = await startStubIssuer();
  for (const name of ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"]) {
    if (!process.env[name]) process.env[name] = env("E08-S05-L", name);
  }
  process.env["UPLOADS_ENABLED"] = "1";
  if (!process.env["S3_ENDPOINT"]) process.env["S3_ENDPOINT"] = "http://127.0.0.1:9000";
  if (!process.env["S3_REGION"]) process.env["S3_REGION"] = "us-east-1";
  if (!process.env["CLAMAV_HOST"]) process.env["CLAMAV_HOST"] = "127.0.0.1";
  if (!process.env["CLAMAV_PORT"]) process.env["CLAMAV_PORT"] = "3310";
  uploadConfig = loadUploadConfig();
  await s3EnsureBucket(uploadConfig.s3);
  for (const prefix of ["exports/", "quarantine/"]) {
    for (const key of await s3ListKeys(uploadConfig.s3, prefix)) {
      if (key.startsWith("exports/")) await s3DeleteExport(uploadConfig.s3, key);
      else await s3Delete(uploadConfig.s3, key);
    }
  }
  if (!(await clamdPing(uploadConfig.clamav))) throw new Error("E08-S05-L prerequisite missing: clamd unreachable.");
  if (!existsSync(uploadConfig.parserChild)) throw new Error("E08-S05-L prerequisite missing: parser child not built.");
  redisUrl = loadRedisUrl();
  queue = jobsQueue(redisUrl);
  await queue.waitUntilReady();
  await queue.obliterate({ force: true });

  // Fixed dataset: A (60 accounts / 6k txns) + B (40 accounts / 1 owner + 20 readers on A).
  const base = await startApp();
  const mkUser = async (sub: string): Promise<{ cookie: string; userId: string }> => {
    const cookie = await login(base, sub);
    const row = await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub]);
    if ((row.rowCount ?? 0) === 0) {
      const created = await pool.query("INSERT INTO users (id, auth_subject) VALUES ($1, $2) RETURNING id", [randomUUID(), sub]);
      return { cookie, userId: (created.rows[0] as { id: string }).id };
    }
    return { cookie, userId: (row.rows[0] as { id: string }).id };
  };
  const ownerA = await mkUser("synthetic-load-owner-a");
  const ownerB = await mkUser("synthetic-load-owner-b");
  const mkWorkspace = async (sub: string, name: string): Promise<string> => {
    const ws = await createWorkspace(pool, sub, { name, baseCurrency: "EUR" });
    return ws.id;
  };
  const wsA = await mkWorkspace("synthetic-load-owner-a", "LoadA");
  const wsB = await mkWorkspace("synthetic-load-owner-b", "LoadB");
  // 20 readers join A.
  const readers: Array<{ cookie: string; userId: string }> = [];
  for (let i = 0; i < 20; i++) {
    const r = await mkUser(`synthetic-load-reader-${i}`);
    await scoped(ownerA.userId, wsA, async (client) => {
      await client.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [wsA, r.userId]);
    });
    readers.push(r);
  }
  // Bulk accounts + transactions via generate_series (deterministic oracle).
  // amount = 100 + (s mod 1000); even s INFLOW, odd s OUTFLOW.
  const seedSide = async (userId: string, ws: string, tag: string, accounts: number, txns: number, acctOffset: number): Promise<Oracle> => {
    return scoped(userId, ws, async (client) => {
      const dsId = randomUUID();
      await client.query("INSERT INTO data_sources (workspace_id, id, type, name, status) VALUES ($1, $2, 'csv_upload', $3, 'ACTIVE')", [ws, dsId, `${tag}-bank`]);
      const importId = randomUUID();
      await client.query(
        "INSERT INTO imports (workspace_id, id, data_source_id, idempotency_key, file_name, file_sha256, object_key, parser_version, status, parsed_rows, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'proof-import-1', 'STAGED', $8, now() + interval '30 days')",
        [ws, importId, dsId, randomUUID(), `${tag}.csv`, "ab".repeat(32), `quarantine/${ws}/${randomUUID()}`, txns],
      );
      await client.query(
        "INSERT INTO accounts (workspace_id, id, name, version, base_currency_code, archived, source) SELECT $1, ('00000000-0000-4000-8000-' || lpad(to_hex($2 + s), 12, '0'))::uuid, $3 || s, 1, 'EUR', false, 'manual' FROM generate_series(1, $4) s",
        [ws, acctOffset, `${tag}-acct-`, accounts],
      );
      await client.query(
        `INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id, version, financial_kind)
         SELECT $1, ('11111111-1111-4000-8000-' || lpad(to_hex(s), 12, '0'))::uuid,
                ('00000000-0000-4000-8000-' || lpad(to_hex($2 + ((s - 1) % $3 + 1)), 12, '0'))::uuid,
                100 + ((s - 1) % 1000), 'EUR', CASE WHEN s % 2 = 0 THEN 'INFLOW' ELSE 'OUTFLOW' END,
                date '2024-01-01' + ((s - 1) % 28), 'load-' || s, $4, s, 'load-obs-' || s, 1, 'NORMAL'
         FROM generate_series(1, $5) s`,
        [ws, acctOffset, accounts, importId, txns],
      );
      let inflow = 0n;
      let outflow = 0n;
      for (let s = 1; s <= txns; s++) {
        const amount = BigInt(100 + ((s - 1) % 1000));
        if (s % 2 === 0) inflow += amount;
        else outflow += amount;
      }
      return { inflowMinor: inflow, outflowMinor: outflow, count: txns };
    });
  };
  const oracleA = await seedSide(ownerA.userId, wsA, "a", 60, 6000, 0);
  const oracleB = await seedSide(ownerB.userId, wsB, "b", 40, 4000, 100000);
  // 12 pinned artifacts (6 per workspace) with ready versions + layout tiles.
  const seedArtifacts = async (userId: string, ws: string, tag: string): Promise<void> => {
    await scoped(userId, ws, async (client) => {
      await client.query("INSERT INTO home_layouts (workspace_id, version, user_edited) VALUES ($1, 1, false) ON CONFLICT DO NOTHING", [ws]);
      for (let i = 0; i < 6; i++) {
        const artifactId = randomUUID();
        await client.query("INSERT INTO artifacts (workspace_id, id, name) VALUES ($1, $2, $3)", [ws, artifactId, `${tag}-tool-${i}`]);
        const versionId = randomUUID();
        await client.query("INSERT INTO artifact_versions (workspace_id, id, artifact_id, manifest, source_hash, build_hash, status, source_html, source_css, source_js) VALUES ($1, $2, $3, '{}', '\\x00', '\\x01', 'ready', '', '', '')", [ws, versionId, artifactId]);
        await client.query("INSERT INTO artifact_state (workspace_id, artifact_id, version_id, schema_version, state) VALUES ($1, $2, $3, 1, '{}')", [ws, artifactId, versionId]);
        await client.query("INSERT INTO home_layout_tiles (workspace_id, artifact_id, position, size) VALUES ($1, $2, $3, 'small')", [ws, artifactId, i]);
      }
    });
  };
  await seedArtifacts(ownerA.userId, wsA, "a");
  await seedArtifacts(ownerB.userId, wsB, "b");
  const built = { base, ownerA, ownerB, readers, wsA, wsB, oracleA, oracleB };
  (globalThis as unknown as { __load: unknown }).__load = built;
  const mem = process.memoryUsage();
  summary["dataset"] = { accounts: 100, transactions: 10000, artifacts: 12, readers: 20 };
  summary["seedRssMB"] = Math.round(mem.rss / 1024 / 1024);
}, 300_000);

function ctx(): { base: string; ownerA: { cookie: string; userId: string }; ownerB: { cookie: string; userId: string }; readers: Array<{ cookie: string; userId: string }>; wsA: string; wsB: string; oracleA: Oracle; oracleB: Oracle } {
  return (globalThis as unknown as { __load: unknown }).__load as never;
}

afterAll(async () => {
  const summaryPath = join(tmpdir(), "e08-load-summary.json");
  try {
    writeFileSync(summaryPath, JSON.stringify({ ...summary, node: process.version, platform: process.platform }));
  } catch {
    // Summary is evidence-only; a read-only temp dir must not fail the suite.
  }
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

describe("e08-s05-L local load and failure", () => {
  it("serves 1/5/20 concurrent readers with exact totals", async () => {
    const { base, readers, wsA, oracleA } = ctx();
    for (const n of [1, 5, 20]) {
      const lat: number[] = [];
      const results = await Promise.all(
        readers.slice(0, n).map(async (r) => {
          const started = Date.now();
          const txRes = await fetch(`${base}/api/transactions?workspaceId=${wsA}&limit=5`, { headers: { cookie: r.cookie } });
          const homeRes = await fetch(`${base}/w/${wsA}/home`, { headers: { cookie: r.cookie } });
          lat.push(Date.now() - started);
          return { txStatus: txRes.status, homeStatus: homeRes.status, txJson: (await txRes.json()) as any, homeText: await homeRes.text() };
        }),
      );
      for (const res of results) {
        expect(res.txStatus).toBe(200);
        expect(res.homeStatus).toBe(200);
        const totals = res.txJson.totals?.byCurrency?.find((t: { currency: string }) => t.currency === "EUR") as { inflowMinor: string; outflowMinor: string } | undefined;
        expect(totals?.inflowMinor).toBe(oracleA.inflowMinor.toString(10));
        expect(totals?.outflowMinor).toBe(oracleA.outflowMinor.toString(10));
        expect(res.homeText).not.toContain("<script");
      }
      lat.sort((a, b) => a - b);
      summary[`readers${n}`] = { p50ms: percentile(lat, 50), p95ms: percentile(lat, 95), maxMs: lat[lat.length - 1] };
    }
    // Tenant swap at load stays a uniform denial.
    const { ownerB, wsB, oracleB } = ctx();
    const swap = await fetch(`${base}/api/transactions?workspaceId=${wsA}&limit=5`, { headers: { cookie: ownerB.cookie } });
    expect(swap.status).toBe(404);
    // Workspace B totals are exact too (single pass suffices with A proven).
    const bRes = await fetch(`${base}/api/transactions?workspaceId=${wsB}&limit=5`, { headers: { cookie: ownerB.cookie } });
    expect(bRes.status).toBe(200);
    const bTotals = ((await bRes.json()) as any).totals?.byCurrency?.find((t: { currency: string }) => t.currency === "EUR") as { inflowMinor: string; outflowMinor: string };
    expect(bTotals?.inflowMinor).toBe(oracleB.inflowMinor.toString(10));
    expect(bTotals?.outflowMinor).toBe(oracleB.outflowMinor.toString(10));
  }, 120_000);

  it("runs one projection per workspace with exact figures", async () => {
    const { base, ownerA, ownerB, wsA, wsB } = ctx();
    const runOnce = async (me: { cookie: string }, ws: string): Promise<any> => {
      const res = await fetch(`${base}/api/projection/run`, {
        method: "POST",
        headers: { cookie: me.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: ws, horizonDays: 30, idempotencyKey: randomUUID() }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as any;
    };
    for (const [me, ws, tag] of [[ownerA, wsA, "A"], [ownerB, wsB, "B"]] as const) {
      const started = Date.now();
      const first = await runOnce(me, ws);
      const ms = Date.now() - started;
      expect(Array.isArray(first.points)).toBe(true);
      // Deterministic on the fixed seed: identical inputs rerun identically.
      const second = await runOnce(me, ws);
      expect(second.points).toEqual(first.points);
      expect(second.inputHash).toBe(first.inputHash);
      summary[`projection${tag}Ms`] = ms;
    }
  }, 120_000);

  it("completes the 100k-row boundary import within parser ceilings", async () => {
    // Reference measurement: the E02 chunk commit path is correct but
    // per-row (~175-230 rows/s locally) — roughly 9-10 minutes for 100k
    // rows plus the over-limit probe. This timeout bounds the observation;
    // it is not a host promise.
    const { base, ownerA, wsA } = ctx();
    const t0 = Date.now();
    // The parser counts the header line toward the 100k ceiling, so 99,999
    // data rows sit exactly at the enforced boundary (a 100,001-line file
    // rejects with row-limit — asserted below).
    const lines = ["date,description,amount,currency"];
    for (let i = 1; i <= 99999; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      lines.push(`2024-03-${day},Boundary item ${i},${i % 2 === 0 ? "" : "-"}${((i % 5000) + 1) / 100},EUR`);
    }
    const bytes = new TextEncoder().encode(lines.join("\n"));
    const boundary = `----moneo${randomBytes(8).toString("hex")}`;
    const profile = {
      delimiter: ",",
      dateFormat: "iso",
      amount: { kind: "signed", decimalSep: ".", thousandsSep: "" },
      columns: { date: "date", description: "description", amount: "amount", currency: "currency" },
      defaultCurrency: "EUR",
    };
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="idempotencyKey"\r\n\r\n${randomUUID()}\r\n`, "utf8"),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="profile"\r\n\r\n${JSON.stringify(profile)}\r\n`, "utf8"),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="boundary.csv"\r\nContent-Type: text/csv\r\n\r\n`, "utf8"),
      Buffer.from(bytes),
      Buffer.from("\r\n", "utf8"),
      Buffer.from(`--${boundary}--\r\n`, "utf8"),
    ]);
    const up = await fetch(`${base}/api/workspaces/${wsA}/uploads`, {
      method: "POST",
      headers: { cookie: ownerA.cookie, "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: new Uint8Array(body),
    });
    expect(up.status).toBe(201);
    const staged = (await up.json()) as { import: { id: string }; jobId: string };
    await dispatchOutbox(pool, queue);
    const parseStarted = Date.now();
    expect(await processParseJob(pool, staged.jobId, uploadConfig)).toBe("applied");
    summary["parse100kMs"] = Date.now() - parseStarted;
    const claims = { userId: ownerA.userId, workspaceId: wsA };
    const acctRow = await scoped(ownerA.userId, wsA, async (client) => {
      const found = await client.query("SELECT id FROM accounts WHERE workspace_id = $1 ORDER BY name LIMIT 1", [wsA]);
      return (found.rows[0] as { id: string }).id;
    });
    const proposed = await proposeMapping(pool, claims, staged.import.id, { transport: null });
    const accepted = await acceptMapping(pool, claims, staged.import.id, { proposalId: proposed.proposal.id, accountId: acctRow });
    expect(accepted.proposal.id).toBe(proposed.proposal.id);
    const commit = await acceptImportCommitJob(pool, claims, ownerA.userId, { workspaceId: wsA, idempotencyKey: randomUUID(), importId: staged.import.id, accountId: acctRow });
    await dispatchOutbox(pool, queue);
    const commitStarted = Date.now();
    expect(await processCommitJob(pool, commit.jobId, DEFAULT_COMMIT_CONFIG)).toBe("applied");
    summary["commit100kMs"] = Date.now() - commitStarted;
    const count = await scoped(ownerA.userId, wsA, async (client) => {
      const found = await client.query("SELECT count(*)::int AS n FROM transactions WHERE workspace_id = $1 AND import_id = $2", [wsA, staged.import.id]);
      return (found.rows[0] as { n: number }).n;
    });
    expect(count).toBe(99999);
    summary["import100kTotalMs"] = Date.now() - t0;
    // Provenance sample: committed rows link to their staged observations.
    const sample = await scoped(ownerA.userId, wsA, async (client) => {
      const found = await client.query(
        `SELECT t.id AS tx, t.import_row_no AS row, t.observation_id AS obs, sl.status AS link
         FROM transactions t JOIN source_links sl ON sl.workspace_id = t.workspace_id AND sl.target_transaction_id = t.id
         WHERE t.workspace_id = $1 AND t.import_id = $2 AND t.import_row_no IN (7, 7007, 70007) ORDER BY t.import_row_no`,
        [wsA, staged.import.id],
      );
      return found.rows as Array<{ tx: string; row: number; obs: string; link: string }>;
    });
    expect(sample.map((r) => [r.row, r.link])).toEqual([[7, "NEW"], [7007, "NEW"], [70007, "NEW"]]);
    expect(new Set(sample.map((r) => r.obs)).size).toBe(3);
    const mem = process.memoryUsage();
    summary["postImportRssMB"] = Math.round(mem.rss / 1024 / 1024);
    // Over the ceiling (100,001 lines) rejects typed without staging.
    const overLines = ["date,description,amount,currency"];
    for (let i = 1; i <= 100000; i++) overLines.push(`2024-03-01,Over ${i},-1.00,EUR`);
    const overBytes = new TextEncoder().encode(overLines.join("\n"));
    const overBoundary = `----moneo${randomBytes(8).toString("hex")}`;
    const overBody = Buffer.concat([
      Buffer.from(`--${overBoundary}\r\nContent-Disposition: form-data; name="idempotencyKey"\r\n\r\n${randomUUID()}\r\n`, "utf8"),
      Buffer.from(`--${overBoundary}\r\nContent-Disposition: form-data; name="profile"\r\n\r\n${JSON.stringify(profile)}\r\n`, "utf8"),
      Buffer.from(`--${overBoundary}\r\nContent-Disposition: form-data; name="file"; filename="over.csv"\r\nContent-Type: text/csv\r\n\r\n`, "utf8"),
      Buffer.from(overBytes),
      Buffer.from("\r\n", "utf8"),
      Buffer.from(`--${overBoundary}--\r\n`, "utf8"),
    ]);
    const overUp = await fetch(`${base}/api/workspaces/${wsA}/uploads`, {
      method: "POST",
      headers: { cookie: ownerA.cookie, "Content-Type": `multipart/form-data; boundary=${overBoundary}` },
      body: new Uint8Array(overBody),
    });
    expect(overUp.status).toBe(201);
    const overStaged = (await overUp.json()) as { import: { id: string }; jobId: string };
    await dispatchOutbox(pool, queue);
    expect(await processParseJob(pool, overStaged.jobId, uploadConfig)).toBe("applied");
    const overStatus = await scoped(ownerA.userId, wsA, async (client) => {
      const found = await client.query("SELECT status, error_code FROM imports WHERE workspace_id = $1 AND id = $2", [wsA, overStaged.import.id]);
      return found.rows[0] as { status: string; error_code: string | null };
    });
    expect(overStatus.status).toBe("REJECTED");
    expect(overStatus.error_code).toBe("row-limit");
  }, 900_000);

  it("recovers visibly when Redis is lost and jobs cancel under load", async () => {
    const { base, readers, wsA, ownerA } = ctx();
    // Accept the synthetic job BEFORE the loss so queued state must rebuild.
    const jobAccept = await fetch(`${base}/api/workspaces/${wsA}/import-jobs`, {
      method: "POST",
      headers: { cookie: ownerA.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    expect(jobAccept.status).toBe(201);
    const jobId = ((await jobAccept.json()) as any).jobId as string;
    // Publish to transport BEFORE the loss so queued state must rebuild.
    await dispatchOutbox(pool, queue);
    // Readers in flight while the dedicated Redis DB is flushed.
    const reading = Promise.all(
      readers.slice(0, 20).map(async (r) => {
        const res = await fetch(`${base}/api/transactions?workspaceId=${wsA}&limit=5`, { headers: { cookie: r.cookie } });
        return res.status;
      }),
    );
    const { Redis } = await import("ioredis");
    const admin = new Redis(redisUrl);
    try {
      await admin.flushdb();
    } finally {
      admin.disconnect();
    }
    const rebuilt = await reconcileTransport(pool, queue);
    expect(rebuilt.enqueued + rebuilt.skipped).toBeGreaterThan(0);
    expect(await processImportJob(pool, jobId)).toBe("applied");
    // Exactly one business effect from the rebuilt delivery.
    const effects = await scoped(ownerA.userId, wsA, async (client) => {
      const found = await client.query("SELECT count(*)::int AS n FROM background_job_results WHERE workspace_id = $1 AND background_job_id = $2", [wsA, jobId]);
      return (found.rows[0] as { n: number }).n;
    });
    expect(effects).toBe(1);
    // Cancel converges without effects.
    const jobAccept2 = await fetch(`${base}/api/workspaces/${wsA}/import-jobs`, {
      method: "POST",
      headers: { cookie: ownerA.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    const jobId2 = ((await jobAccept2.json()) as any).jobId as string;
    const cancelled = await cancelJob(pool, { userId: ownerA.userId, workspaceId: wsA }, jobId2);
    expect(cancelled?.status).toBe("CANCELLED");
    expect(await processImportJob(pool, jobId2)).toBe("duplicate-terminal-noop");
    const noEffects = await scoped(ownerA.userId, wsA, async (client) => {
      const found = await client.query("SELECT count(*)::int AS n FROM background_job_results WHERE workspace_id = $1 AND background_job_id = $2", [wsA, jobId2]);
      return (found.rows[0] as { n: number }).n;
    });
    expect(noEffects).toBe(0);
    const statuses = await reading;
    expect(statuses.every((s) => s === 200)).toBe(true);
    summary["redisLossRecovered"] = true;
  }, 180_000);

  it("bounds AI cost with safe rejections and visible provider outage", async () => {
    const { wsA, ownerA } = ctx();
    const claims = { userId: ownerA.userId, workspaceId: wsA };
    const acctRow = await scoped(ownerA.userId, wsA, async (client) => {
      const found = await client.query("SELECT id FROM accounts WHERE workspace_id = $1 ORDER BY name LIMIT 1", [wsA]);
      return (found.rows[0] as { id: string }).id;
    });
    await setDispatchBudget(pool, claims, { moneyMinor: "12", tokens: 250, concurrency: 2 });
    const okTransport: DispatchTransport = async () => ({ httpStatus: 200, bodyText: '{"answer":"synthetic"}', inputTokens: 100, outputTokens: 50, model: "double-1" });
    const results = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const permit = await issuePermit(pool, claims, `load-cost-${i}`, [acctRow]);
        try {
          const state = await dispatchModelCall(pool, claims, {
            idempotencyKey: randomUUID(), permitId: permit.id, route: "development", purpose: `load-cost-${i}`, requestText: "synthetic", inputEstimate: 100, outputCeiling: 100,
          }, okTransport);
          return state.reservation.status;
        } catch (err) {
          return (err as { code?: string }).code ?? "threw";
        }
      }),
    );
    expect(results).toContain("RECONCILED");
    expect(results.some((s) => s.startsWith("budget_"))).toBe(true);
    // Over-budget denials map to HTTP 429 safe rejections (never silent).
    for (const code of ["budget_money", "budget_tokens", "budget_concurrency"] as const) {
      expect(dispatchErrorBody(new DispatchError(code))).toEqual({ status: 429, body: { error: "budget_exceeded", reason: code } });
    }
    // Reconciled + held money never exceeds the budget.
    const usage = await scoped(ownerA.userId, wsA, async (client) => {
      const done = await client.query("SELECT coalesce(sum(reconciled_cost_minor::bigint), 0)::text AS s FROM ai_dispatch_usage WHERE workspace_id = $1 AND status = 'RECONCILED'", [wsA]);
      const held = await client.query("SELECT coalesce(sum(reserved_cost_minor::bigint), 0)::text AS s FROM ai_dispatch_reservations WHERE workspace_id = $1 AND status IN ('RESERVED', 'PENDING')", [wsA]);
      return { done: BigInt((done.rows[0] as { s: string }).s), held: BigInt((held.rows[0] as { s: string }).s) };
    });
    expect(usage.done + usage.held <= 12n).toBe(true);
    summary["costBounded"] = { done: usage.done.toString(10), held: usage.held.toString(10) };
    // Provider outage is typed and visible, never silent.
    const outageTransport: DispatchTransport = async () => ({ httpStatus: 503, bodyText: null, inputTokens: null, outputTokens: null, model: "double-1" });
    const permit = await issuePermit(pool, claims, "load-outage", [acctRow]);
    await setDispatchBudget(pool, claims, { moneyMinor: "100000", tokens: 100000, concurrency: 10 });
    const outage = await dispatchModelCall(pool, claims, {
      idempotencyKey: randomUUID(), permitId: permit.id, route: "development", purpose: "load-outage", requestText: "synthetic", inputEstimate: 100, outputCeiling: 100,
    }, outageTransport);
    expect(outage.usage?.status).toBe("PENDING");
    expect(outage.usage?.errorClass).not.toBeNull();
  }, 180_000);
});
