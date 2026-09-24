// E08-S01c-L local retention: 30-day upload-bytes purge with holds,
// 24-hour cross-workspace export sweep, tombstone immunity and
// catalog/text/code agreement. Real disposable PostgreSQL
// (`moneo_e08_retention`, fails closed) + real MinIO (loopback, disposable
// bucket). Synthetic data only. Backdated markers stand in for clock
// advance (deterministic, no wall-clock races); no scheduler exists locally
// (S01c-D owns cadence).

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
import { processExportJob } from "../apps/web/src/export.ts";
import { RETENTION_CATALOG, TOMBSTONE_RETENTION_DAYS, sweepRetention } from "../apps/web/src/retention.ts";
import { s3DeleteExport, s3EnsureBucket, s3ListKeys, s3Put, type S3Config } from "../apps/web/src/s3.ts";
import { ensureTestMigrationPool, ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let admin: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
let s3: S3Config;
const savedEnv: Record<string, string | undefined> = {};

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

async function setupWorkspace(base: string, sub: string): Promise<{ cookie: string; workspaceId: string; userId: string }> {
  const cookie = await login(base, sub);
  const ws = (await (
    await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "RetW", baseCurrency: "EUR" }),
    })
  ).json()) as { id: string };
  const userRow = await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub]);
  return { cookie, workspaceId: ws.id, userId: (userRow.rows[0] as { id: string }).id };
}

function scoped<T>(userId: string, workspaceId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(pool, { userId, workspaceId }, work);
}

/** Seed one import with real quarantined bytes; caller chooses status/marker/hold. */
async function seedImport(
  userId: string,
  workspaceId: string,
  tag: string,
  opts: { status: "STAGED" | "REJECTED" | "PARSING"; backdateExpiry: boolean; retain: boolean },
): Promise<{ importId: string; objectKey: string }> {
  const objectKey = `quarantine/${workspaceId}/${randomUUID()}`;
  await s3Put(s3, objectKey, new TextEncoder().encode(`${tag}-bytes`), "text/csv");
  await scoped(userId, workspaceId, async (client) => {
    const ds = await client.query("SELECT id FROM data_sources WHERE workspace_id = $1 LIMIT 1", [workspaceId]);
    let dsId: string;
    if ((ds.rowCount ?? 0) === 0) {
      dsId = randomUUID();
      await client.query("INSERT INTO data_sources (workspace_id, id, type, name, status) VALUES ($1, $2, 'csv_upload', 'bank', 'ACTIVE')", [workspaceId, dsId]);
    } else {
      dsId = (ds.rows[0] as { id: string }).id;
    }
    const importId = randomUUID();
    await client.query(
      "INSERT INTO imports (workspace_id, id, data_source_id, idempotency_key, file_name, file_sha256, object_key, parser_version, status, parsed_rows, expires_at, retain_original) VALUES ($1, $2, $3, $4, $5, $6, $7, 'proof-import-1', $8, 1, $9, $10)",
      [workspaceId, importId, dsId, randomUUID(), `${tag}.csv`, "ab".repeat(32), objectKey, opts.status, opts.backdateExpiry ? "2000-01-01T00:00:00Z" : "2999-01-01T00:00:00Z", opts.retain],
    );
    await client.query("INSERT INTO source_objects (workspace_id, id, import_id, object_key, size_bytes, sha256, status) VALUES ($1, $2, $3, $4, 11, $5, 'ACCEPTED')", [
      workspaceId,
      randomUUID(),
      importId,
      objectKey,
      "cd".repeat(32),
    ]);
    await client.query("INSERT INTO parsed_observations (workspace_id, import_id, row_no, status, observation_id, amount_minor, currency, direction, effective_date, description) VALUES ($1, $2, 2, 'STAGED', 'obs-1', '100', 'EUR', 'INFLOW', '2024-01-02', 'x')", [
      workspaceId,
      importId,
    ]);
    if (opts.backdateExpiry) {
      await client.query("INSERT INTO import_expiry_index (workspace_id, import_id, expires_at) VALUES ($1, $2, '2000-01-01T00:00:00Z') ON CONFLICT DO NOTHING", [workspaceId, importId]);
    }
  });
  const importRow = await scoped(userId, workspaceId, async (client) => {
    const found = await client.query("SELECT id FROM imports WHERE workspace_id = $1 AND file_name = $2", [workspaceId, `${tag}.csv`]);
    return (found.rows[0] as { id: string }).id;
  });
  return { importId: importRow, objectKey };
}

beforeAll(async () => {
  for (const name of ["EXPORTS_ENABLED", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"]) {
    savedEnv[name] = process.env[name];
  }
  pool = await ensureTestPool("E08-S01c-L", "moneo_e08_retention", [
    "import_expiry_index",
    "export_expiry_index",
    "deletion_tombstones",
    "deletion_requests",
    "export_packages",
    "background_job_attempts",
    "job_dispatch_index",
    "outbox_events",
    "background_job_results",
    "background_jobs",
    "command_operations",
    "parsed_observations",
    "source_objects",
    "imports",
    "data_sources",
    "accounts",
    "workspace_members",
    "workspaces",
    "users",
    "app_sessions",
  ]);
  admin = await ensureTestMigrationPool("E08-S01c-L", "moneo_e08_retention");
  stub = await startStubIssuer();
  for (const name of ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"]) {
    if (!process.env[name]) process.env[name] = env("E08-S01c-L", name);
  }
  process.env["EXPORTS_ENABLED"] = "1";
  if (!process.env["S3_ENDPOINT"]) process.env["S3_ENDPOINT"] = "http://127.0.0.1:9000";
  if (!process.env["S3_REGION"]) process.env["S3_REGION"] = "us-east-1";
  const { loadExportConfig } = await import("../apps/web/src/export.ts");
  s3 = loadExportConfig().s3;
  await s3EnsureBucket(s3);
  for (const prefix of ["exports/", "quarantine/"]) {
    const leftovers = await s3ListKeys(s3, prefix);
    for (const key of leftovers) {
      if (key.startsWith("exports/")) await s3DeleteExport(s3, key);
      else {
        const { s3Delete } = await import("../apps/web/src/s3.ts");
        await s3Delete(s3, key);
      }
    }
  }
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
  if (pool) await pool.end();
  if (admin) await admin.end();
});

describe("e08-s01c-L local retention", () => {
  it("purges eligible bytes once while holds and provenance survive", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-ret-owner-a");
    const staged = await seedImport(me.userId, me.workspaceId, "staged-old", { status: "STAGED", backdateExpiry: true, retain: false });
    const retained = await seedImport(me.userId, me.workspaceId, "retained-old", { status: "STAGED", backdateExpiry: true, retain: true });
    const parsing = await seedImport(me.userId, me.workspaceId, "parsing-old", { status: "PARSING", backdateExpiry: false, retain: false });
    const rejected = await seedImport(me.userId, me.workspaceId, "rejected-old", { status: "REJECTED", backdateExpiry: true, retain: false });

    const first = await sweepRetention(pool, s3, 100);
    expect(first.purgedUploads).toBe(2);
    // Retained is due-but-held; the unmarked in-flight import is never due.
    expect(first.heldUploads).toBe(1);
    expect(first.failed).toBe(0);
    // Eligible objects + rows are gone; canonical observations stay.
    const remaining = await s3ListKeys(s3, `quarantine/${me.workspaceId}/`);
    expect(remaining.sort()).toEqual([parsing.objectKey, retained.objectKey].sort());
    await scoped(me.userId, me.workspaceId, async (client) => {
      const objects = await client.query("SELECT object_key FROM source_objects WHERE workspace_id = $1 ORDER BY object_key", [me.workspaceId]);
      expect((objects.rows as Array<{ object_key: string }>).map((r) => r.object_key).sort()).toEqual([parsing.objectKey, retained.objectKey].sort());
      const observations = await client.query("SELECT count(*)::int AS n FROM parsed_observations WHERE workspace_id = $1", [me.workspaceId]);
      expect((observations.rows[0] as { n: number }).n).toBe(4);
      const imports = await client.query("SELECT count(*)::int AS n FROM imports WHERE workspace_id = $1", [me.workspaceId]);
      expect((imports.rows[0] as { n: number }).n).toBe(4);
      const index = await client.query("SELECT import_id FROM import_expiry_index WHERE workspace_id = $1", [me.workspaceId]);
      // Only the held retained import keeps its index row (consumed rows are
      // cleaned; the unmarked in-flight import was never indexed).
      expect((index.rows as Array<{ import_id: string }>).map((r) => r.import_id)).toEqual([retained.importId]);
    });
    void staged;
    void rejected;
    // A second sweep finds nothing due: purge-once semantics.
    const second = await sweepRetention(pool, s3, 100);
    expect(second.purgedUploads).toBe(0);
    expect(second.heldUploads).toBe(1);
  });

  it("expires backdated READY exports cross-workspace while tombstones survive", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "synthetic-ret-exp-a");
    const b = await setupWorkspace(base, "synthetic-ret-exp-b");
    // Full export lifecycle without Redis: HTTP accept, direct fenced build.
    async function readyPackage(owner: { cookie: string; workspaceId: string; userId: string }): Promise<string> {
      const accepted = await fetch(`${base}/api/workspaces/${owner.workspaceId}/exports`, {
        method: "POST",
        headers: { cookie: owner.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: randomUUID() }),
      });
      expect(accepted.status).toBe(202);
      const body = (await accepted.json()) as any;
      expect(await processExportJob(pool, body.jobId, s3)).toBe("applied");
      return body.packageId as string;
    }
    const pkgA = await readyPackage(a);
    const pkgB = await readyPackage(b);
    // Backdate both expiries (synthetic clock advance) plus an old tombstone.
    // Package rows are RLS-protected: backdate them as the operator would.
    await admin.query("UPDATE export_packages SET expires_at = '2000-01-01T00:00:00Z' WHERE id IN ($1, $2)", [pkgA, pkgB]);
    await pool.query("UPDATE export_expiry_index SET expires_at = '2000-01-01T00:00:00Z' WHERE package_id IN ($1, $2)", [pkgA, pkgB]);
    const tombId = randomUUID();
    await pool.query("INSERT INTO deletion_tombstones (id, subject_kind, subject_ref, scope, request_id, basis, deleted_at) VALUES ($1, 'identity', $2, 'identity', $3, 'erasure-request', now() - interval '44 days')", [
      tombId,
      a.userId,
      randomUUID(),
    ]);

    const swept = await sweepRetention(pool, s3, 100);
    expect(swept.expiredExports).toBe(2);
    expect(swept.failed).toBe(0);
    expect(await s3ListKeys(s3, `exports/${a.workspaceId}/`)).toEqual([]);
    expect(await s3ListKeys(s3, `exports/${b.workspaceId}/`)).toEqual([]);
    for (const pkg of [pkgA, pkgB]) {
      const row = await admin.query("SELECT status, object_key, data_key FROM export_packages WHERE id = $1", [pkg]);
      expect((row.rows[0] as { status: string }).status).toBe("EXPIRED");
      expect((row.rows[0] as { object_key: string | null }).object_key).toBeNull();
    }
    const indexLeft = await pool.query("SELECT count(*)::int AS n FROM export_expiry_index WHERE package_id IN ($1, $2)", [pkgA, pkgB]);
    expect((indexLeft.rows[0] as { n: number }).n).toBe(0);
    // The 44-day tombstone survives every sweep (45-day floor).
    const tomb = await pool.query("SELECT count(*)::int AS n FROM deletion_tombstones WHERE id = $1", [tombId]);
    expect((tomb.rows[0] as { n: number }).n).toBe(1);
    expect(TOMBSTONE_RETENTION_DAYS).toBe(45);
  });

  it("a failed download keeps its index row so the sweep still converges", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-ret-reopen-a");
    const accepted = await fetch(`${base}/api/workspaces/${me.workspaceId}/exports`, {
      method: "POST",
      headers: { cookie: me.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    expect(accepted.status).toBe(202);
    const body = (await accepted.json()) as any;
    expect(await processExportJob(pool, body.jobId, s3)).toBe("applied");
    const packageId = body.packageId as string;
    // Lose the object, then attempt the download while unexpired: consume
    // succeeds, the fetch fails, the single use reopens with index intact.
    const keys = await s3ListKeys(s3, `exports/${me.workspaceId}/`);
    expect(keys.length).toBe(1);
    await s3DeleteExport(s3, keys[0]);
    const dl = await fetch(`${base}/api/workspaces/${me.workspaceId}/exports/${packageId}/download`, { headers: { cookie: me.cookie } });
    expect(dl.status).toBe(404);
    const reopened = await admin.query("SELECT downloaded_at FROM export_packages WHERE id = $1", [packageId]);
    expect((reopened.rows[0] as { downloaded_at: string | null }).downloaded_at).toBeNull();
    const indexKept = await pool.query("SELECT count(*)::int AS n FROM export_expiry_index WHERE package_id = $1", [packageId]);
    expect((indexKept.rows[0] as { n: number }).n).toBe(1);
    // Advance the clock: the sweep converges on the kept index row.
    await admin.query("UPDATE export_packages SET expires_at = '2000-01-01T00:00:00Z' WHERE id = $1", [packageId]);
    await pool.query("UPDATE export_expiry_index SET expires_at = '2000-01-01T00:00:00Z' WHERE package_id = $1", [packageId]);
    // The sweep converges: missing object tolerates delete, row expires.
    const swept = await sweepRetention(pool, s3, 100);
    expect(swept.expiredExports).toBe(1);
    const indexGone = await pool.query("SELECT count(*)::int AS n FROM export_expiry_index WHERE package_id = $1", [packageId]);
    expect((indexGone.rows[0] as { n: number }).n).toBe(0);
  });

  it("broken storage stays visible and converges after restore", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-ret-outage-a");
    const seeded = await seedImport(me.userId, me.workspaceId, "outage-old", { status: "STAGED", backdateExpiry: true, retain: false });
    const badS3: S3Config = { ...s3, endpoint: "http://127.0.0.1:9" };
    const failed = await sweepRetention(pool, badS3, 100);
    expect(failed.failed).toBe(1);
    expect(failed.purgedUploads).toBe(0);
    // Nothing was half-purged: object and rows still present, index retained.
    expect(await s3ListKeys(s3, `quarantine/${me.workspaceId}/`)).toEqual([seeded.objectKey]);
    const restored = await sweepRetention(pool, s3, 100);
    expect(restored.purgedUploads).toBe(1);
    expect(await s3ListKeys(s3, `quarantine/${me.workspaceId}/`)).toEqual([]);
  });

  it("missing storage counts due work as failed without touching data", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-ret-nostore-a");
    await seedImport(me.userId, me.workspaceId, "nostore-old", { status: "STAGED", backdateExpiry: true, retain: false });
    const counts = await sweepRetention(pool, null, 100);
    expect(counts.failed).toBeGreaterThan(0);
    expect(counts.purgedUploads).toBe(0);
    expect(counts.expiredExports).toBe(0);
  });

  it("catalog, privacy text and code name the same durations", async () => {
    const byClass = Object.fromEntries(RETENTION_CATALOG.map((e) => [e.class, e]));
    expect(byClass["original uploaded bytes"].retention).toContain("30 days");
    expect(byClass["original uploaded bytes"].enforced).toBe(true);
    expect(byClass["temporary export bundle"].retention).toContain("24 hours");
    expect(byClass["temporary export bundle"].enforced).toBe(true);
    expect(byClass["deletion tombstones"].retention).toContain("45 days");
    for (const gated of ["AI operational metadata", "queue execution records", "security audit events", "backups"]) {
      expect(byClass[gated].enforced).toBe(false);
      expect(byClass[gated].retention).not.toMatch(/\d+ (days|hours)/);
    }
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-ret-text-a");
    const pageText = await (await fetch(`${base}/w/${me.workspaceId}/privacy`, { headers: { cookie: me.cookie } })).text();
    expect(pageText).toContain("30 days");
    expect(pageText).toContain("24 hours");
    expect(pageText).toContain("45 days");
    expect(pageText).toContain("set after hosting selection");
    expect(pageText).not.toContain("<script");
  });
});
