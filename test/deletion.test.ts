// E08-S01b durable deletion: workspace purge, identity removal with shared
// finance preserved, successor/sole-member rules, checkpoint resume,
// tombstones and uniform denial. Real disposable PostgreSQL
// (`moneo_e08_deletion`, fails closed), real Redis (dedicated logical DB 9,
// loopback-guarded) and real MinIO (loopback, disposable bucket). Synthetic
// users/workspaces/finance only. Zero-row assertions use a superuser pool
// (bypasses RLS for setup verification); every product read goes through
// tenant context.

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
import { dispatchOutbox, jobsQueue, processImportJob, type JobPayload } from "../apps/web/src/jobs.ts";
import { listTombstones, resetExternalIdentityDeleter, setDeletionTestFault, externalIdentityDeleteCalls } from "../apps/web/src/deletion.ts";
import { processExportJob } from "../apps/web/src/export.ts";
import { loadExportConfig } from "../apps/web/src/export.ts";
import { s3DeleteExport, s3EnsureBucket, s3ListKeys, s3Put, type S3Config } from "../apps/web/src/s3.ts";
import { ensureTestMigrationPool, ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

const MEMBER_SENTINEL = "departing-member-sentinel-4k2m";
const OWNER_SENTINEL = "remaining-owner-sentinel-8p1q";

let pool: Pool;
let admin: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
let redisUrl: string;
let queue: Queue<JobPayload>;
let s3: S3Config;
const savedEnv: Record<string, string | undefined> = {};

function deletionRedisUrl(): string {
  const base = env("E08-S01b", "REDIS_URL");
  const u = new URL(base);
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("E08-S01b refused: REDIS_URL must point at the local disposable Redis.");
  }
  const db = process.env["DELETION_REDIS_DB"] ?? "9";
  if (!/^\d+$/.test(db) || Number(db) < 0 || Number(db) > 15) throw new Error("E08-S01b misconfigured: DELETION_REDIS_DB must be 0-15.");
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

async function setupWorkspace(base: string, sub: string): Promise<{ cookie: string; workspaceId: string; userId: string }> {
  const cookie = await login(base, sub);
  const ws = (await (
    await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "DelW", baseCurrency: "EUR" }),
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

/** Seed finance + content + one quarantined object with real bytes. */
async function seedWorkspace(userId: string, workspaceId: string, tag: string): Promise<{ accountId: string; objectKey: string }> {
  const objectKey = `quarantine/${workspaceId}/${randomUUID()}`;
  await s3Put(s3, objectKey, new TextEncoder().encode(`${tag}-bytes`), "text/csv");
  await scoped(userId, workspaceId, async (client) => {
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
      [workspaceId, importId, dsId, randomUUID(), `${tag}.csv`, "cd".repeat(32), objectKey],
    );
    await client.query("INSERT INTO source_objects (workspace_id, id, import_id, object_key, size_bytes, sha256, status) VALUES ($1, $2, $3, $4, 11, $5, 'ACCEPTED')", [
      workspaceId,
      randomUUID(),
      importId,
      objectKey,
      "ef".repeat(32),
    ]);
    await client.query("INSERT INTO parsed_observations (workspace_id, import_id, row_no, status, observation_id, amount_minor, currency, direction, effective_date, description) VALUES ($1, $2, 2, 'STAGED', 'obs-1', '250000', 'EUR', 'INFLOW', '2024-01-02', 'Salary')", [
      workspaceId,
      importId,
    ]);
    await client.query(
      "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id, version, financial_kind) VALUES ($1, $2, $3, 250000, 'EUR', 'INFLOW', '2024-01-02', 'Salary', $4, 2, 'obs-1', 1, 'NORMAL')",
      [workspaceId, randomUUID(), accountId, importId],
    );
    await client.query(
      "INSERT INTO manual_transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, actor_id, version, financial_kind) VALUES ($1, $2, $3, 1225, 'EUR', 'OUTFLOW', '2024-01-04', 'Cash', $4, 1, 'NORMAL')",
      [workspaceId, randomUUID(), accountId, userId],
    );
    await client.query("INSERT INTO goals (workspace_id, id, name, goal_type, status, target_amount_minor, currency_code, version) VALUES ($1, $2, $3, 'SAVINGS_TARGET', 'ACTIVE', 500000, 'EUR', 1)", [
      workspaceId,
      randomUUID(),
      `${tag}-goal`,
    ]);
    const artifactId = randomUUID();
    await client.query("INSERT INTO artifacts (workspace_id, id, name) VALUES ($1, $2, $3)", [workspaceId, artifactId, `${tag}-chart`]);
    const versionId = randomUUID();
    await client.query("INSERT INTO artifact_versions (workspace_id, id, artifact_id, manifest, source_hash, build_hash, status, source_html, source_css, source_js) VALUES ($1, $2, $3, '{}', '\\x00', '\\x01', 'ready', '', '', '')", [
      workspaceId,
      versionId,
      artifactId,
    ]);
    await client.query("INSERT INTO artifact_state (workspace_id, artifact_id, version_id, schema_version, state) VALUES ($1, $2, $3, 1, '{}')", [workspaceId, artifactId, versionId]);
  });
  const accountRow = await admin.query("SELECT id FROM accounts WHERE workspace_id = $1", [workspaceId]);
  return { accountId: (accountRow.rows[0] as { id: string }).id, objectKey };
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
    await client.query("INSERT INTO notices (workspace_id, user_id, id, source_event, kind, title, body) VALUES ($1, $2, $3, 'test-seed', 'chat_completed', $4, 'n')", [workspaceId, userId, randomUUID(), title]);
  });
}

async function requestDeletion(
  base: string,
  cookie: string,
  workspaceId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/deletions`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey: randomUUID(), ...body }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function workspaceTableCounts(workspaceId: string): Promise<Record<string, number>> {
  const tables = ["accounts", "transactions", "manual_transactions", "imports", "source_objects", "parsed_observations", "goals", "artifacts", "artifact_versions", "chat_threads", "chat_turns", "notices", "background_jobs", "outbox_events", "command_operations", "export_packages", "deletion_requests", "workspace_members", "audit_events"];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const r = await admin.query(`SELECT count(*)::int AS n FROM ${t} WHERE workspace_id = $1`, [workspaceId]);
    out[t] = (r.rows[0] as { n: number }).n;
  }
  return out;
}

beforeAll(async () => {
  for (const name of ["DELETIONS_ENABLED", "EXPORTS_ENABLED", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET", "DELETION_REDIS_DB"]) {
    savedEnv[name] = process.env[name];
  }
  pool = await ensureTestPool("E08-S01b", "moneo_e08_deletion", [
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
    "review_decisions",
    "source_links",
    "transactions",
    "manual_transactions",
    "balance_snapshots",
    "balance_audit",
    "imports",
    "data_sources",
    "source_objects",
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
  admin = await ensureTestMigrationPool("E08-S01b", "moneo_e08_deletion");
  stub = await startStubIssuer();
  for (const name of ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"]) {
    if (!process.env[name]) process.env[name] = env("E08-S01b", name);
  }
  if (!process.env["S3_ENDPOINT"]) process.env["S3_ENDPOINT"] = "http://127.0.0.1:9000";
  if (!process.env["S3_REGION"]) process.env["S3_REGION"] = "us-east-1";
  process.env["DELETIONS_ENABLED"] = "1";
  process.env["EXPORTS_ENABLED"] = "1";
  const exportConfig = loadExportConfig();
  s3 = exportConfig.s3;
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
  redisUrl = deletionRedisUrl();
  queue = jobsQueue(redisUrl);
  await queue.waitUntilReady();
  await queue.obliterate({ force: true });
  resetExternalIdentityDeleter();
}, 120_000);

afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  setDeletionTestFault(null);
  resetExternalIdentityDeleter();
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (queue) await queue.close();
  if (pool) await pool.end();
  if (admin) await admin.end();
});

describe("e08-s01b durable deletion", () => {
  it("owner workspace deletion purges rows, objects, sessions with one tombstone", async () => {
    const base = await startApp();
    const owner = await setupWorkspace(base, "synthetic-del-owner-a");
    const member = await addMember(owner, "synthetic-del-member-a");
    const memberCookie = await login(base, "synthetic-del-member-a");
    await seedWorkspace(owner.userId, owner.workspaceId, "ws-a");
    await seedThread(owner.userId, owner.workspaceId, "owner thread", OWNER_SENTINEL);
    // A second workspace proves scoping: it must survive untouched.
    const other = await setupWorkspace(base, "synthetic-del-owner-a");
    await seedWorkspace(owner.userId, other.workspaceId, "ws-b");
    // A real export package + a queued job prove effect/object cancellation.
    const expKey = randomUUID();
    const expAccept = await fetch(`${base}/api/workspaces/${owner.workspaceId}/exports`, {
      method: "POST",
      headers: { cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: expKey }),
    });
    expect(expAccept.status).toBe(202);
    const expJob = ((await expAccept.json()) as any).jobId as string;
    await dispatchOutbox(pool, queue);
    expect(await processExportJob(pool, expJob, s3)).toBe("applied");
    const jobAccept = await fetch(`${base}/api/workspaces/${owner.workspaceId}/import-jobs`, {
      method: "POST",
      headers: { cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    expect(jobAccept.status).toBe(201);

    const res = await requestDeletion(base, owner.cookie, owner.workspaceId, { scope: "workspace" });
    expect(res.status).toBe(202);
    expect(res.json.deletion.status).toBe("COMPLETE");

    // Every domain row for A is gone (superuser bypasses RLS for the count).
    const counts = await workspaceTableCounts(owner.workspaceId);
    for (const [table, n] of Object.entries(counts)) {
      expect(`${table}:${n}`).toBe(`${table}:0`);
    }
    const wsRow = await admin.query("SELECT count(*)::int AS n FROM workspaces WHERE id = $1", [owner.workspaceId]);
    expect((wsRow.rows[0] as { n: number }).n).toBe(0);
    // Objects are gone; B's objects remain.
    expect(await s3ListKeys(s3, `exports/${owner.workspaceId}/`)).toEqual([]);
    expect(await s3ListKeys(s3, `quarantine/${owner.workspaceId}/`)).toEqual([]);
    expect((await s3ListKeys(s3, `quarantine/${other.workspaceId}/`)).length).toBe(1);
    // One workspace tombstone, UUIDs/codes only.
    const tombs = (await listTombstones(pool)).filter((t) => t.requestId === res.json.deletion.id);
    expect(tombs.length).toBe(1);
    expect(tombs[0]).toMatchObject({ subjectKind: "workspace", subjectRef: owner.workspaceId, scope: "workspace" });
    // Access is revoked for both members; sessions are dead.
    expect((await fetch(`${base}/api/workspaces?`, { headers: { cookie: owner.cookie } })).status).toBe(401);
    const meOwner = await fetch(`${base}/api/me`, { headers: { cookie: owner.cookie } });
    expect(meOwner.status).toBe(401);
    expect((await fetch(`${base}/api/me`, { headers: { cookie: memberCookie } })).status).toBe(401);
    const otherWorks = await fetch(`${base}/api/workspaces`, { headers: { cookie: (await login(base, "synthetic-del-owner-a")) } });
    expect(otherWorks.status).toBe(200);
    const otherWorksBody = JSON.stringify(await otherWorks.json());
    expect(otherWorksBody).toContain(other.workspaceId);
    expect(otherWorksBody).not.toContain(owner.workspaceId);
    void member;
  });

  it("shared identity deletion preserves finance and purges only the departed member", async () => {
    const base = await startApp();
    const owner = await setupWorkspace(base, "synthetic-del2-owner");
    const member = await addMember(owner, "synthetic-del2-member");
    const memberCookie = await login(base, "synthetic-del2-member");
    await seedWorkspace(owner.userId, owner.workspaceId, "shared");
    await seedThread(owner.userId, owner.workspaceId, "owner thread", OWNER_SENTINEL);
    await seedThread(member.userId, owner.workspaceId, "member thread", MEMBER_SENTINEL);
    // Member's own export + queued job must die with the identity.
    const expAccept = await fetch(`${base}/api/workspaces/${owner.workspaceId}/exports`, {
      method: "POST",
      headers: { cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    expect(expAccept.status).toBe(202);
    const expJob = ((await expAccept.json()) as any).jobId as string;
    await dispatchOutbox(pool, queue);
    expect(await processExportJob(pool, expJob, s3)).toBe("applied");
    const jobAccept = await fetch(`${base}/api/workspaces/${owner.workspaceId}/import-jobs`, {
      method: "POST",
      headers: { cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    const memberJobId = ((await jobAccept.json()) as any).jobId as string;

    const before = await admin.query("SELECT coalesce(sum(amount_minor),0)::text AS s, count(*)::int AS n FROM transactions WHERE workspace_id = $1", [owner.workspaceId]);
    const res = await requestDeletion(base, memberCookie, owner.workspaceId, { scope: "identity" });
    expect(res.status).toBe(202);
    expect(res.json.deletion.status).toBe("COMPLETE");

    // Shared finance is byte-identical for the remaining member.
    const after = await admin.query("SELECT coalesce(sum(amount_minor),0)::text AS s, count(*)::int AS n FROM transactions WHERE workspace_id = $1", [owner.workspaceId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const kept = await admin.query("SELECT count(*)::int AS n FROM (SELECT 1 FROM goals WHERE workspace_id = $1 UNION ALL SELECT 1 FROM artifacts WHERE workspace_id = $1 UNION ALL SELECT 1 FROM manual_transactions WHERE workspace_id = $1) t", [owner.workspaceId]);
    expect((kept.rows[0] as { n: number }).n).toBe(3);
    const ownerThread = await admin.query("SELECT count(*)::int AS n FROM chat_threads WHERE workspace_id = $1", [owner.workspaceId]);
    expect((ownerThread.rows[0] as { n: number }).n).toBe(1);
    // The departed member is fully gone: membership, sessions, threads,
    // notices, exports + objects, grants; identity anonymized + Keycloak cut.
    const gone = await admin.query(
      "SELECT (SELECT count(*)::int FROM workspace_members WHERE workspace_id = $1 AND user_id = $2) AS m, (SELECT count(*)::int FROM chat_threads WHERE workspace_id = $1 AND created_by = $2) AS t, (SELECT count(*)::int FROM chat_turns WHERE workspace_id = $1 AND thread_id IN (SELECT id FROM chat_threads WHERE workspace_id = $1 AND created_by = $2)) AS tu, (SELECT count(*)::int FROM notices WHERE workspace_id = $1 AND user_id = $2) AS n, (SELECT count(*)::int FROM export_packages WHERE workspace_id = $1 AND requested_by = $2) AS e",
      [owner.workspaceId, member.userId],
    );
    expect(Object.values(gone.rows[0] as Record<string, number>).every((n) => n === 0)).toBe(true);
    expect(await s3ListKeys(s3, `exports/${owner.workspaceId}/`)).toEqual([]);
    const userRow = await admin.query("SELECT auth_subject FROM users WHERE id = $1", [member.userId]);
    expect((userRow.rows[0] as { auth_subject: string }).auth_subject.startsWith("deleted:")).toBe(true);
    expect(externalIdentityDeleteCalls()).toContain("synthetic-del2-member");
    expect((await fetch(`${base}/api/me`, { headers: { cookie: memberCookie } })).status).toBe(401);
    // The member's late job cannot write: cancelled and fenced to noop.
    const cancelled = await admin.query("SELECT status FROM background_jobs WHERE workspace_id = $1 AND id = $2", [owner.workspaceId, memberJobId]);
    expect((cancelled.rows[0] as { status: string }).status).toBe("CANCELLED");
    await dispatchOutbox(pool, queue);
    expect(await processImportJob(pool, memberJobId)).toBe("duplicate-terminal-noop");
    // Owner still works.
    const ownerList = await fetch(`${base}/api/accounts?workspaceId=${owner.workspaceId}`, { headers: { cookie: owner.cookie } });
    expect(ownerList.status).toBe(200);
  });

  it("sole-owner handoff is atomic; sole members purge", async () => {
    const base = await startApp();
    const owner1 = await setupWorkspace(base, "synthetic-del3-owner1");
    const member2 = await addMember(owner1, "synthetic-del3-member2");
    await seedWorkspace(owner1.userId, owner1.workspaceId, "handoff");
    // Refused without a successor; nothing irreversible happened.
    const refused = await requestDeletion(base, owner1.cookie, owner1.workspaceId, { scope: "identity" });
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({ error: "conflict", reason: "successor_required" });
    const still = await admin.query("SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [owner1.workspaceId, owner1.userId]);
    expect((still.rows[0] as { role: string }).role).toBe("owner");
    // Invalid successor is refused the same way.
    const badSuccessor = await requestDeletion(base, owner1.cookie, owner1.workspaceId, { scope: "identity", successorUserId: randomUUID() });
    expect(badSuccessor.status).toBe(409);
    // With a successor the handoff is atomic: new owner + departed gone.
    const handoff = await requestDeletion(base, owner1.cookie, owner1.workspaceId, { scope: "identity", successorUserId: member2.userId });
    expect(handoff.status).toBe(202);
    expect(handoff.json.deletion.status).toBe("COMPLETE");
    const roles = await admin.query("SELECT user_id, role FROM workspace_members WHERE workspace_id = $1", [owner1.workspaceId]);
    expect(roles.rows).toEqual([{ user_id: member2.userId, role: "owner" }]);
    const finance = await admin.query("SELECT count(*)::int AS n FROM transactions WHERE workspace_id = $1", [owner1.workspaceId]);
    expect((finance.rows[0] as { n: number }).n).toBe(1);
    // Sole-member workspace purges entirely.
    const solo = await setupWorkspace(base, "synthetic-del3-solo");
    await seedWorkspace(solo.userId, solo.workspaceId, "solo");
    const purge = await requestDeletion(base, solo.cookie, solo.workspaceId, { scope: "identity" });
    expect(purge.json.deletion.status).toBe("COMPLETE");
    expect((await admin.query("SELECT count(*)::int AS n FROM workspaces WHERE id = $1", [solo.workspaceId])).rows[0]).toEqual({ n: 0 });
    const tombs = (await listTombstones(pool)).filter((t) => t.requestId === purge.json.deletion.id);
    expect(tombs.length).toBe(1);
    expect(tombs[0]).toMatchObject({ subjectKind: "identity", scope: "identity" });
  });

  it("purges the 10k-row batch path within bounds", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-del9-scale");
    const seeded = await seedWorkspace(me.userId, me.workspaceId, "scale");
    const importRow = await admin.query("SELECT id FROM imports WHERE workspace_id = $1", [me.workspaceId]);
    const importId = (importRow.rows[0] as { id: string }).id;
    await scoped(me.userId, me.workspaceId, async (client) => {
      await client.query(
        "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id, version, financial_kind) SELECT $1, ('00000000-0000-4000-8000-' || lpad(to_hex(s), 12, '0'))::uuid, $2, 100 + s, 'EUR', 'OUTFLOW', '2024-02-01', 'bulk-' || s, $3, s + 100, 'scale-obs-' || s, 1, 'NORMAL' FROM generate_series(1, 10000) s",
        [me.workspaceId, seeded.accountId, importId],
      );
    });
    const before = await admin.query("SELECT count(*)::int AS n FROM transactions WHERE workspace_id = $1", [me.workspaceId]);
    expect((before.rows[0] as { n: number }).n).toBe(10001);
    const started = Date.now();
    const res = await requestDeletion(base, me.cookie, me.workspaceId, { scope: "workspace" });
    expect(res.json.deletion.status).toBe("COMPLETE");
    expect(Date.now() - started).toBeLessThan(120_000);
    const counts = await workspaceTableCounts(me.workspaceId);
    for (const [table, n] of Object.entries(counts)) {
      expect(`${table}:${n}`).toBe(`${table}:0`);
    }
    expect(await s3ListKeys(s3, `quarantine/${me.workspaceId}/`)).toEqual([]);
  });

  it("crash mid-purge resumes to one completion with the flag already revoking", async () => {
    const base = await startApp();
    const owner = await setupWorkspace(base, "synthetic-del4-owner");
    await seedWorkspace(owner.userId, owner.workspaceId, "crash");
    const key = randomUUID();
    setDeletionTestFault(3);
    try {
      const first = await requestDeletion(base, owner.cookie, owner.workspaceId, { scope: "workspace", idempotencyKey: key });
      expect(first.status).toBe(202);
      expect(first.json.deletion.status).toBe("FAILED");
      expect(first.json.deletion.errorCode).toBe("fault_injected");
    } finally {
      setDeletionTestFault(null);
    }
    // Revocation precedes completion: reads already deny uniformly.
    expect((await fetch(`${base}/api/accounts?workspaceId=${owner.workspaceId}`, { headers: { cookie: owner.cookie } })).status).toBe(404);
    // Same-key retry resumes from checkpoints to a single completion.
    const retry = await requestDeletion(base, owner.cookie, owner.workspaceId, { scope: "workspace", idempotencyKey: key });
    expect(retry.json.deletion.status).toBe("COMPLETE");
    expect(retry.json.replayed).toBe(true);
    const counts = await workspaceTableCounts(owner.workspaceId);
    for (const [table, n] of Object.entries(counts)) {
      expect(`${table}:${n}`).toBe(`${table}:0`);
    }
    const tombs = (await listTombstones(pool)).filter((t) => t.requestId === retry.json.deletion.id);
    expect(tombs.length).toBe(1);
  });

  it("object-store failure stays visible and retryable, never complete", async () => {
    const base = await startApp();
    const owner = await setupWorkspace(base, "synthetic-del5-owner");
    await seedWorkspace(owner.userId, owner.workspaceId, "objfail");
    const saved = { endpoint: process.env["S3_ENDPOINT"], access: process.env["S3_ACCESS_KEY"], secret: process.env["S3_SECRET_KEY"], bucket: process.env["S3_BUCKET"] };
    const key = randomUUID();
    delete process.env["S3_ENDPOINT"];
    try {
      const res = await requestDeletion(base, owner.cookie, owner.workspaceId, { scope: "workspace", idempotencyKey: key });
      expect(res.json.deletion.status).toBe("FAILED");
      expect(res.json.deletion.errorCode).toBe("object_store_unavailable");
    } finally {
      process.env["S3_ENDPOINT"] = saved.endpoint;
      process.env["S3_ACCESS_KEY"] = saved.access;
      process.env["S3_SECRET_KEY"] = saved.secret;
      process.env["S3_BUCKET"] = saved.bucket;
    }
    // Resume requires the same idempotency key once revocation is set.
    const retry = await requestDeletion(base, owner.cookie, owner.workspaceId, { scope: "workspace", idempotencyKey: key });
    expect(retry.json.deletion.status).toBe("COMPLETE");
    expect(await s3ListKeys(s3, `quarantine/${owner.workspaceId}/`)).toEqual([]);
    // A live S3 outage mid-purge maps to the same visible FAILED (not a 500):
    // break the endpoint on a fresh workspace and retry with the same key.
    const owner2 = await setupWorkspace(base, "synthetic-del5-owner2");
    await seedWorkspace(owner2.userId, owner2.workspaceId, "objfail2");
    const key2 = randomUUID();
    process.env["S3_ENDPOINT"] = "http://127.0.0.1:9";
    try {
      const outage = await requestDeletion(base, owner2.cookie, owner2.workspaceId, { scope: "workspace", idempotencyKey: key2 });
      expect(outage.json.deletion.status).toBe("FAILED");
      expect(outage.json.deletion.errorCode).toBe("object_store_unavailable");
    } finally {
      process.env["S3_ENDPOINT"] = saved.endpoint;
    }
    const retry2 = await requestDeletion(base, owner2.cookie, owner2.workspaceId, { scope: "workspace", idempotencyKey: key2 });
    expect(retry2.json.deletion.status).toBe("COMPLETE");
  });

  it("foreign actors, stale step-up and disabled deletions deny cleanly", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "synthetic-del6-a");
    const c = await setupWorkspace(base, "synthetic-del6-c");
    await seedWorkspace(a.userId, a.workspaceId, "gated");
    // Foreign actor sees uniform 404.
    const foreign = await requestDeletion(base, c.cookie, a.workspaceId, { scope: "workspace" });
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual({ error: "not_found" });
    // Non-owners cannot delete the workspace.
    const m = await addMember(a, "synthetic-del6-member");
    void m;
    const memberCookie = await login(base, "synthetic-del6-member");
    const nonOwner = await requestDeletion(base, memberCookie, a.workspaceId, { scope: "workspace" });
    expect(nonOwner.status).toBe(403);
    // Stale step-up denies on the requester's own session.
    await pool.query("UPDATE app_sessions SET step_up_at = now() - interval '10 minutes' WHERE keycloak_sub = $1", ["synthetic-del6-a"]);
    const stale = await requestDeletion(base, a.cookie, a.workspaceId, { scope: "workspace" });
    expect(stale.status).toBe(403);
    expect(stale.json).toEqual({ error: "forbidden", reason: "step_up_required" });
    // Disabled deletions hide as 404.
    delete process.env["DELETIONS_ENABLED"];
    try {
      const freshCookie = await login(base, "synthetic-del6-a");
      const hidden = await requestDeletion(base, freshCookie, a.workspaceId, { scope: "workspace" });
      expect(hidden.status).toBe(404);
    } finally {
      process.env["DELETIONS_ENABLED"] = "1";
    }
  });

  it("multi-workspace identities finalize only on the last membership", async () => {
    const base = await startApp();
    const home = await setupWorkspace(base, "synthetic-del7-multi");
    const away = await setupWorkspace(base, "synthetic-del7-multi");
    await seedWorkspace(home.userId, home.workspaceId, "home");
    await seedWorkspace(home.userId, away.workspaceId, "away");
    resetExternalIdentityDeleter();
    const first = await requestDeletion(base, home.cookie, home.workspaceId, { scope: "identity" });
    expect(first.json.deletion.status).toBe("COMPLETE");
    // Still a member elsewhere: identity survives, Keycloak untouched.
    const userRow = await admin.query("SELECT auth_subject FROM users WHERE id = $1", [home.userId]);
    expect((userRow.rows[0] as { auth_subject: string }).auth_subject).toBe("synthetic-del7-multi");
    expect(externalIdentityDeleteCalls()).toEqual([]);
    const freshCookie = await login(base, "synthetic-del7-multi");
    const second = await requestDeletion(base, freshCookie, away.workspaceId, { scope: "identity" });
    expect(second.json.deletion.status).toBe("COMPLETE");
    const anon = await admin.query("SELECT auth_subject FROM users WHERE id = $1", [home.userId]);
    expect((anon.rows[0] as { auth_subject: string }).auth_subject.startsWith("deleted:")).toBe(true);
    expect(externalIdentityDeleteCalls()).toEqual(["synthetic-del7-multi"]);
  });

  it("privacy page offers deletion with explicit confirmation", async () => {
    const base = await startApp();
    const owner = await setupWorkspace(base, "synthetic-del8-owner");
    const member = await addMember(owner, "synthetic-del8-member");
    const memberCookie = await login(base, "synthetic-del8-member");
    await seedWorkspace(owner.userId, owner.workspaceId, "ui");
    const ownerPage = await (await fetch(`${base}/w/${owner.workspaceId}/privacy`, { headers: { cookie: owner.cookie } })).text();
    expect(ownerPage).toContain("Delete this workspace");
    expect(ownerPage).toContain("Delete my identity");
    expect(ownerPage).toContain("Type DELETE to confirm");
    expect(ownerPage).not.toContain("<script");
    const memberPage = await (await fetch(`${base}/w/${owner.workspaceId}/privacy`, { headers: { cookie: memberCookie } })).text();
    expect(memberPage).not.toContain("Delete this workspace");
    expect(memberPage).toContain("Delete my identity");
    // Missing confirmation wording is rejected without side effects.
    const noConfirm = await fetch(`${base}/w/${owner.workspaceId}/privacy/delete`, {
      method: "POST",
      headers: { cookie: memberCookie, "Content-Type": "application/x-www-form-urlencoded", origin: base },
      body: new URLSearchParams({ scope: "identity", idempotencyKey: randomUUID(), confirm: "please" }).toString(),
      redirect: "manual",
    });
    expect(noConfirm.status).toBe(400);
    const confirmed = await fetch(`${base}/w/${owner.workspaceId}/privacy/delete`, {
      method: "POST",
      headers: { cookie: memberCookie, "Content-Type": "application/x-www-form-urlencoded", origin: base },
      body: new URLSearchParams({ scope: "identity", idempotencyKey: randomUUID(), confirm: "DELETE" }).toString(),
      redirect: "manual",
    });
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get("location")).toContain("notice=deleted");
    void member;
  });
});
