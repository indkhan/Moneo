// E02-S01 durable jobs + outbox dispatch: synthetic imports.start accept,
// PG-first outbox, minimal BullMQ payload, idempotent handler. Real
// PostgreSQL (`moneo_e02_jobs`, fails closed) + real Redis (dedicated
// logical DB 14, loopback-guarded; only this DB is ever flushed).
// Synthetic users/workspaces only. Every direct DB assertion runs inside
// withTenant — unscoped app-role reads return zero rows by design (FORCE
// RLS), and the suite asserts that property explicitly.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import {
  discoverJobWorkspace,
  dispatchOutbox,
  jobsQueue,
  processImportJob,
  resolveJobRoute,
  type JobPayload,
} from "../apps/web/src/jobs.ts";
import { ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
let redisUrl: string;
let redisDb: number;
let queue: Queue<JobPayload>;

function jobsRedisUrl(): string {
  const base = env("E02-S01", "REDIS_URL");
  const u = new URL(base);
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("E02-S01 refused: REDIS_URL must point at the local disposable Redis.");
  }
  const db = process.env["JOBS_REDIS_DB"] ?? "14";
  if (!/^\d+$/.test(db) || Number(db) < 0 || Number(db) > 15) throw new Error("E02-S01 misconfigured: JOBS_REDIS_DB must be 0-15.");
  redisDb = Number(db);
  u.pathname = `/${db}`;
  return u.toString();
}

async function startApp(): Promise<string> {
  const config: AuthConfig = {
    issuer: stub.base,
    clientId: STUB_CLIENT_ID,
    clientSecret: STUB_CLIENT_SECRET,
    appBaseUrl: "http://127.0.0.1:1",
    sessionSecret,
    sessionTtlSec: 43200,
  };
  const server = createApp(
    createAuthRouter(config, pool),
    createTenancyRouter(pool, (req) => requestSession(pool, sessionSecret, req)),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  appServers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.appBaseUrl = base;
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
      body: JSON.stringify({ name: "W", baseCurrency: "EUR" }),
    })
  ).json()) as { id: string };
  const userRow = await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub]);
  return { cookie, workspaceId: ws.id, userId: (userRow.rows[0] as { id: string }).id };
}

/** Run work as a workspace member (membership + RLS enforced). */
function scoped<T>(userId: string, workspaceId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(pool, { userId, workspaceId }, work);
}

async function accept(base: string, cookie: string, workspaceId: string, idempotencyKey: string, label?: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/import-jobs`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(label === undefined ? { idempotencyKey } : { idempotencyKey, label }),
  });
  return { status: res.status, json: (await res.json()) as unknown };
}

async function readJobHttp(base: string, cookie: string, workspaceId: string, jobId: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/jobs/${jobId}`, { headers: { cookie } });
  return { status: res.status, json: (await res.json()) as unknown };
}

async function resultCount(userId: string, workspaceId: string, jobId: string): Promise<number> {
  return scoped(userId, workspaceId, async (client) => {
    const r = await client.query("SELECT count(*)::int AS n FROM background_job_results WHERE workspace_id = $1 AND background_job_id = $2", [
      workspaceId,
      jobId,
    ]);
    return (r.rows[0] as { n: number }).n;
  });
}

beforeAll(async () => {
  pool = await ensureTestPool("E02-S01", "moneo_e02_jobs", [
    "job_dispatch_index",
    "outbox_events",
    "background_job_results",
    "background_jobs",
    "ai_dispatch_permits",
    "ai_exclusions",
    "ai_policies",
    "command_operations",
    "accounts",
    "workspace_members",
    "workspaces",
    "users",
    "app_sessions",
  ]);
  stub = await startStubIssuer();
  redisUrl = jobsRedisUrl();
  queue = jobsQueue(redisUrl);
  await queue.waitUntilReady();
  await queue.obliterate({ force: true });
}, 60_000);

afterAll(async () => {
  if (queue) await queue.close();
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e02-s01 jobs and outbox dispatch", () => {
  it("concurrent duplicate accept converges to one job and one effect; incompatible reuse conflicts", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-jobs-a");
    const key = randomUUID();
    const started = Date.now();
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => accept(base, cookie, workspaceId, key)),
    );
    expect(Date.now() - started).toBeLessThan(30_000);
    const ok = attempts.filter((a) => a.status === 200 || a.status === 201);
    expect(ok.length).toBe(20);
    const jobIds = new Set(ok.map((a) => ((a.json as { jobId: string }).jobId)));
    const opIds = new Set(ok.map((a) => ((a.json as { operationId: string }).operationId)));
    expect(jobIds.size).toBe(1);
    expect(opIds.size).toBe(1);
    const jobId = [...jobIds][0];
    // Lost-response retry returns the same job as a replay.
    const retry = await accept(base, cookie, workspaceId, key);
    expect([200, 201]).toContain(retry.status);
    expect((retry.json as { jobId: string }).jobId).toBe(jobId);
    expect((retry.json as { replayed: boolean }).replayed).toBe(true);
    // Incompatible reuse (same key, different label) conflicts.
    const clash = await accept(base, cookie, workspaceId, key, "other-label");
    expect(clash.status).toBe(409);
    expect(clash.json).toMatchObject({ error: "conflict", reason: "idempotency_reuse" });
    // Expired keys return an explicit expired conflict, never a new job.
    await scoped(userId, workspaceId, (client) =>
      client.query(
        "UPDATE command_operations SET expires_at = now() - interval '1 second' WHERE workspace_id = $1 AND command_name = 'imports.start' AND idempotency_key = $2",
        [workspaceId, key],
      ).then(() => undefined),
    );
    const expired = await accept(base, cookie, workspaceId, key);
    expect(expired.status).toBe(409);
    expect(expired.json).toMatchObject({ error: "conflict", reason: "idempotency_expired" });
    // Dispatch + process exactly once despite duplicate transport delivery.
    const counts = await dispatchOutbox(pool, queue);
    expect(counts.enqueued).toBeGreaterThanOrEqual(1);
    const first = await processImportJob(pool, jobId);
    expect(first).toBe("applied");
    const second = await processImportJob(pool, jobId);
    expect(second).toBe("duplicate-terminal-noop");
    expect(await resultCount(userId, workspaceId, jobId)).toBe(1);
  });

  it("dispatch crash windows stay recoverable without a second job or effect", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-jobs-b");
    const key = randomUUID();
    const created = await accept(base, cookie, workspaceId, key);
    expect([200, 201]).toContain(created.status);
    const jobId = (created.json as { jobId: string }).jobId;
    // Window 1: crash before enqueue (row unpublished) -> dispatch recovers.
    const unpublished = await scoped(userId, workspaceId, async (client) => {
      const r = await client.query("SELECT count(*)::int AS n FROM outbox_events WHERE workspace_id = $1 AND published_at IS NULL", [workspaceId]);
      return (r.rows[0] as { n: number }).n;
    });
    expect(unpublished).toBeGreaterThanOrEqual(1);
    await dispatchOutbox(pool, queue);
    // Window 2: crash after enqueue but before published_at -> simulate by
    // reopening the row, then re-dispatch; the deterministic outbox-<id> key
    // and the PG fence must prevent a second logical job/effect.
    await scoped(userId, workspaceId, (client) =>
      client.query("UPDATE outbox_events SET published_at = NULL WHERE workspace_id = $1 AND aggregate_id = $2", [workspaceId, jobId]).then(() => undefined),
    );
    await dispatchOutbox(pool, queue);
    await dispatchOutbox(pool, queue);
    const jobs = await scoped(userId, workspaceId, async (client) => {
      const r = await client.query("SELECT count(*)::int AS n FROM background_jobs WHERE workspace_id = $1 AND id = $2", [workspaceId, jobId]);
      return (r.rows[0] as { n: number }).n;
    });
    expect(jobs).toBe(1);
    expect(await processImportJob(pool, jobId)).toBe("applied");
    expect(await processImportJob(pool, jobId)).toBe("duplicate-terminal-noop");
    // Terminal work is consumed, never re-enqueued as new logical work.
    const again = await dispatchOutbox(pool, queue);
    expect(again.enqueued).toBe(0);
    expect(await resultCount(userId, workspaceId, jobId)).toBe(1);
  });

  it("tenant B and missing ids are indistinguishable; unscoped reads return nothing; discovery exposes ids only", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "synthetic-jobs-c-a");
    const b = await setupWorkspace(base, "synthetic-jobs-c-b");
    const created = await accept(base, a.cookie, a.workspaceId, randomUUID());
    const jobId = (created.json as { jobId: string }).jobId;
    const foreign = await readJobHttp(base, b.cookie, b.workspaceId, jobId);
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual({ error: "not_found" });
    const missing = await readJobHttp(base, b.cookie, b.workspaceId, randomUUID());
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: "not_found" });
    const swapped = await readJobHttp(base, a.cookie, a.workspaceId, randomUUID());
    expect(swapped).toEqual(missing);
    // Unscoped app-role reads return no rows (FORCE RLS defense in depth).
    const unscoped = await pool.query("SELECT count(*)::int AS n FROM background_jobs");
    expect((unscoped.rows[0] as { n: number }).n).toBe(0);
    const unscopedResults = await pool.query("SELECT count(*)::int AS n FROM background_job_results");
    expect((unscopedResults.rows[0] as { n: number }).n).toBe(0);
    const unscopedOutbox = await pool.query("SELECT count(*)::int AS n FROM outbox_events");
    expect((unscopedOutbox.rows[0] as { n: number }).n).toBe(0);
    // Dispatcher discovery exposes only the workspace id for a job id, and
    // the route carries only UUIDs (no payload, finance or secret).
    expect(await discoverJobWorkspace(pool, jobId)).toBe(a.workspaceId);
    expect(await discoverJobWorkspace(pool, randomUUID())).toBeNull();
    const route = await resolveJobRoute(pool, jobId);
    expect(route).toMatchObject({ workspaceId: a.workspaceId, acceptedBy: a.userId });
    expect(Object.keys(route!).sort()).toEqual(["acceptedBy", "outboxId", "workspaceId"]);
    expect(await resolveJobRoute(pool, randomUUID())).toBeNull();
  });

  it("dispatch index stays ID-only; terminal duplicate delivery is a noop; Redis payload is minimal and leak-free", async () => {
    // Schema guard: the globally-readable index must never gain a payload,
    // finance or secret column — UUIDs and timestamps only.
    const cols = await pool.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'job_dispatch_index' ORDER BY column_name",
    );
    const allowed: Record<string, string[]> = {
      workspace_id: ["uuid"],
      job_id: ["uuid"],
      outbox_id: ["uuid"],
      accepted_by: ["uuid"],
      created_at: ["timestamp with time zone"],
    };
    expect(cols.rows.map((r) => (r as { column_name: string }).column_name).sort()).toEqual(Object.keys(allowed).sort());
    for (const row of cols.rows as { column_name: string; data_type: string }[]) {
      expect(allowed[row.column_name]).toContain(row.data_type);
    }
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-jobs-d");
    const created = await accept(base, cookie, workspaceId, randomUUID());
    const jobId = (created.json as { jobId: string }).jobId;
    await dispatchOutbox(pool, queue);
    expect(await processImportJob(pool, jobId)).toBe("applied");
    // Inspect the actual Redis record for the outbox event.
    const outboxId = await scoped(userId, workspaceId, async (client) => {
      const r = await client.query("SELECT id FROM outbox_events WHERE workspace_id = $1 AND aggregate_id = $2", [workspaceId, jobId]);
      return (r.rows[0] as { id: string }).id;
    });
    const bullJob = await queue.getJob(`outbox-${outboxId}`);
    expect(bullJob).not.toBeNull();
    const data = bullJob!.data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(["backgroundJobId"]);
    expect(data["backgroundJobId"]).toBe(jobId);
    const raw = JSON.stringify(data);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(1024);
    for (const needle of ["cookie", "token", "begin private", "policy", "synthetic-jobs", "label", "amount", "iban"]) {
      expect(raw.toLowerCase()).not.toContain(needle);
    }
    // Late duplicate delivery after SUCCEEDED exits without a new effect.
    expect(await processImportJob(pool, jobId)).toBe("duplicate-terminal-noop");
    expect(await resultCount(userId, workspaceId, jobId)).toBe(1);
    // Least-privilege posture: app role cannot bypass RLS; RLS is forced on
    // every tenant table (the ID-only index intentionally carries none).
    const role = await pool.query("SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user");
    expect((role.rows[0] as { bypass: boolean }).bypass).toBe(false);
    for (const table of ["background_jobs", "background_job_results", "outbox_events"]) {
      const forced = await pool.query("SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = $1", [table]);
      expect((forced.rows[0] as { forced: boolean }).forced).toBe(true);
    }
    // Immutable results reject mutation (scoped so the row is visible).
    await expect(
      scoped(userId, workspaceId, (client) => client.query("UPDATE background_job_results SET result_kind = 'synthetic-noop' WHERE workspace_id = $1", [workspaceId])),
    ).rejects.toThrow();
  });

  it("workspace fairness caps active synthetic jobs and recovers after completion", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-jobs-e");
    const first = await accept(base, cookie, workspaceId, randomUUID());
    const second = await accept(base, cookie, workspaceId, randomUUID());
    expect([200, 201]).toContain(first.status);
    expect([200, 201]).toContain(second.status);
    const third = await accept(base, cookie, workspaceId, randomUUID());
    expect(third.status).toBe(409);
    expect(third.json).toMatchObject({ error: "conflict", reason: "workspace_busy" });
    await dispatchOutbox(pool, queue);
    expect(await processImportJob(pool, (first.json as { jobId: string }).jobId)).toBe("applied");
    const after = await accept(base, cookie, workspaceId, randomUUID());
    expect([200, 201]).toContain(after.status);
  });

  it("unauthenticated callers get 401 and foreign workspaces get uniform 404", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "synthetic-jobs-f-a");
    const anon = await fetch(`${base}/api/workspaces/${a.workspaceId}/import-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    expect(anon.status).toBe(401);
    const b = await setupWorkspace(base, "synthetic-jobs-f-b");
    const foreign = await accept(base, b.cookie, a.workspaceId, randomUUID());
    expect(foreign.status).toBe(404);
  });

  it("complete Redis loss rebuilds transport from PG without duplicate effects", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-jobs-h");
    const created = await accept(base, cookie, workspaceId, randomUUID());
    const jobId = (created.json as { jobId: string }).jobId;
    await dispatchOutbox(pool, queue);
    // Lose the entire dedicated Redis DB (loopback-guarded dedicated DB
    // only — never a shared service); the PG index still routes the job.
    const admin = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    try {
      await admin.flushdb();
    } finally {
      admin.disconnect();
    }
    expect(await queue.getJob(`outbox-${(await resolveJobRoute(pool, jobId))!.outboxId}`)).toBeUndefined();
    const recovered = await dispatchOutbox(pool, queue);
    expect(recovered.enqueued).toBeGreaterThanOrEqual(1);
    expect(await processImportJob(pool, jobId)).toBe("applied");
    expect(await processImportJob(pool, jobId)).toBe("duplicate-terminal-noop");
    expect(await resultCount(userId, workspaceId, jobId)).toBe(1);
    expect(redisDb).not.toBe(0);
  });

  it("100-job recovery fixture finishes within 30 seconds", async () => {
    const base = await startApp();
    const started = Date.now();
    const jobIds: string[] = [];
    for (let wave = 0; wave < 50; wave++) {
      const wav = await setupWorkspace(base, `synthetic-jobs-g-${wave}`);
      const first = await accept(base, wav.cookie, wav.workspaceId, randomUUID());
      const second = await accept(base, wav.cookie, wav.workspaceId, randomUUID());
      expect([200, 201]).toContain(first.status);
      expect([200, 201]).toContain(second.status);
      jobIds.push((first.json as { jobId: string }).jobId, (second.json as { jobId: string }).jobId);
    }
    expect(jobIds.length).toBe(100);
    for (let guard = 0; guard < 10; guard++) {
      const drained = await dispatchOutbox(pool, queue, 50);
      if (drained.enqueued === 0) break;
    }
    for (const jobId of jobIds) {
      expect(await processImportJob(pool, jobId)).toBe("applied");
    }
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 90_000);
});
