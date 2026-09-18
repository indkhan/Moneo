// E02-S02 fenced recovery, attempt history and durable cancel. Real
// PostgreSQL (`moneo_e02_recovery`, fails closed) + real Redis (dedicated
// logical DB 13, loopback-guarded; only this DB is ever flushed). Worker
// death is a real SIGKILLed child process at each persisted boundary —
// never an in-process simulation. Synthetic users/workspaces only.

import { spawn, type ChildProcess } from "node:child_process";
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
import { withDatabase } from "../apps/web/src/db.ts";
import {
  dispatchOutbox,
  jobsQueue,
  processImportJob,
  resolveJobRoute,
  type JobPayload,
} from "../apps/web/src/jobs.ts";
import {
  cancelJob,
  checkpointAttempt,
  claimAttempt,
  commitEffectFenced,
  heartbeatAttempt,
  reconcileTransport,
  RecoveryError,
} from "../apps/web/src/job-recovery.ts";
import { createWorkerService } from "../apps/worker/src/main.ts";
import { ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
let redisUrl: string;
let redisDb: number;
let queue: Queue<JobPayload>;
let appDbUrl: string;

const FAULT_LEASE_MS = 2000;

function recoveryRedisUrl(): string {
  const base = env("E02-S02", "REDIS_URL");
  const u = new URL(base);
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("E02-S02 refused: REDIS_URL must point at the local disposable Redis.");
  }
  const db = process.env["RECOVERY_REDIS_DB"] ?? "13";
  if (!/^\d+$/.test(db) || Number(db) < 0 || Number(db) > 15) throw new Error("E02-S02 misconfigured: RECOVERY_REDIS_DB must be 0-15.");
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

function scoped<T>(userId: string, workspaceId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(pool, { userId, workspaceId }, work);
}

async function accept(base: string, cookie: string, workspaceId: string, key = randomUUID()): Promise<{ jobId: string; status: number; json: unknown }> {
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/import-jobs`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey: key }),
  });
  const json = (await res.json()) as unknown;
  return { jobId: (json as { jobId: string }).jobId, status: res.status, json };
}

async function cancelHttp(base: string, cookie: string, workspaceId: string, jobId: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/jobs/${jobId}/cancel`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return { status: res.status, json: (await res.json()) as unknown };
}

async function readJobHttp(base: string, cookie: string, workspaceId: string, jobId: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/jobs/${jobId}`, { headers: { cookie } });
  return { status: res.status, json: (await res.json()) as unknown };
}

async function jobStatus(userId: string, workspaceId: string, jobId: string): Promise<string> {
  return scoped(userId, workspaceId, async (client) => {
    const r = await client.query("SELECT status FROM background_jobs WHERE workspace_id = $1 AND id = $2", [workspaceId, jobId]);
    return (r.rows[0] as { status: string }).status;
  });
}

async function attemptHistory(userId: string, workspaceId: string, jobId: string): Promise<{ attempt_no: number; generation: string; status: string; checkpoint_stage: string | null }[]> {
  return scoped(userId, workspaceId, async (client) => {
    const r = await client.query(
      "SELECT attempt_no, generation, status, checkpoint_stage FROM background_job_attempts WHERE workspace_id = $1 AND background_job_id = $2 ORDER BY attempt_no",
      [workspaceId, jobId],
    );
    return r.rows as { attempt_no: number; generation: string; status: string; checkpoint_stage: string | null }[];
  });
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

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

type FaultPhase = "after-claim" | "after-checkpoint" | "after-effect";

function spawnFaultChild(opts: { userId: string; workspaceId: string; jobId: string; phase: FaultPhase }): Promise<{ marker: FaultPhase; signal: string | null }> {
  // Kill timing comes from PG truth (vitest buffers console output until
  // the hanging test ends, so stdio markers are unreliable): once the child
  // persists the phase's boundary, SIGKILL the real process, then resolve
  // from the persisted state — never from stdio text. Reads use the known
  // test membership (the commit boundary deletes the dispatch index, so the
  // poll must not route through it).
  const { userId, workspaceId, jobId, phase } = opts;
  const targetStage = phase === "after-claim" ? "claimed" : phase === "after-checkpoint" ? "checkpoint-a" : null;
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", "test/helpers/job-fault-child.test.ts", "--pool=threads", "--maxWorkers=1"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          E02_FAULT_DB_URL: withDatabase(appDbUrl, "moneo_e02_recovery"),
          E02_FAULT_JOB: jobId,
          E02_FAULT_PHASE: phase,
          E02_FAULT_LEASE_MS: String(FAULT_LEASE_MS),
        },
      },
    );
    let stderr = "";
    let settled = false;
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout?.on("data", () => undefined);
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
        reject(err);
      }
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`fault child did not persist ${phase} in 30s. stderr=${stderr.slice(-800) || "none"}`));
    }, 30_000);
    const readState = async (): Promise<{ status: string; progress_stage: string | null } | null> => {
      return withTenant(pool, { userId, workspaceId }, async (client) => {
        const found = await client.query("SELECT status, progress_stage FROM background_jobs WHERE workspace_id = $1 AND id = $2", [
          workspaceId,
          jobId,
        ]);
        return (found.rowCount ?? 0) === 0 ? null : (found.rows[0] as { status: string; progress_stage: string | null });
      });
    };
    const poll = setInterval(() => {
      void (async () => {
        if (settled) return;
        try {
          const seen = await readState();
          if (!seen) return;
          const reached = targetStage !== null ? seen.progress_stage === targetStage : seen.status === "SUCCEEDED";
          if (reached) {
            // Past the boundary: give the child a beat to enter its hang,
            // then kill the real process for certain.
            setTimeout(() => {
              try { child.kill("SIGKILL"); } catch { /* already gone */ }
            }, 300);
          }
        } catch {
          // Transient poll failure: keep waiting until the timeout.
        }
      })();
    }, 150);
    child.on("exit", (_code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      void (async () => {
        try {
          const seen = await readState();
          const reached =
            seen !== null && (targetStage !== null ? seen.progress_stage === targetStage || (phase !== "after-claim" && seen.status === "SUCCEEDED") : seen.status === "SUCCEEDED");
          if (reached) resolve({ marker: phase, signal });
          else reject(new Error(`fault child exited before persisting ${phase}: ${stderr.trim().slice(0, 400) || "no stderr"}`));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  });
}

async function reclaimAndFinish(jobId: string, workerId: string): Promise<"applied" | "duplicate-terminal-noop"> {
  const route = await resolveJobRoute(pool, jobId);
  expect(route).not.toBeNull();
  const full = { ...route!, jobId };
  // Wait out the dead worker's lease, then reclaim with a new generation.
  // An immediate attempt must observe the live lease instead of stealing it.
  await expect(claimAttempt(pool, full, `${workerId}-early`, FAULT_LEASE_MS)).rejects.toMatchObject({ code: "lease_held" });
  await new Promise((r) => setTimeout(r, FAULT_LEASE_MS + 400));
  const claim = await claimAttempt(pool, full, workerId, FAULT_LEASE_MS);
  const pick = { attemptId: claim.attemptId, generation: claim.generation };
  expect(await heartbeatAttempt(pool, full, claim.attemptId)).toBe(true);
  expect(await checkpointAttempt(pool, full, pick, "checkpoint-a")).toMatchObject({ ok: true });
  expect(await checkpointAttempt(pool, full, pick, "checkpoint-b")).toMatchObject({ ok: true });
  const published = await commitEffectFenced(pool, full, pick);
  expect(published).toMatchObject({ ok: true });
  return "applied";
}

beforeAll(async () => {
  pool = await ensureTestPool("E02-S02", "moneo_e02_recovery", [
    "background_job_attempts",
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
  appDbUrl = env("E02-S02", "DATABASE_URL");
  redisUrl = recoveryRedisUrl();
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

describe("e02-s02 recovery, fencing and cancel", () => {
  it("death after claim resumes with one effect and preserved attempt history", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-rec-a");
    const { jobId } = await accept(base, cookie, workspaceId);
    await dispatchOutbox(pool, queue);
    const killed = await spawnFaultChild({ userId, workspaceId, jobId, phase: "after-claim" });
    expect(killed.marker).toBe("after-claim");
    // The dead attempt held generation 1; recovery reclaims generation 2.
    expect(await reclaimAndFinish(jobId, "recovery-a")).toBe("applied");
    expect(await jobStatus(userId, workspaceId, jobId)).toBe("SUCCEEDED");
    expect(await resultCount(userId, workspaceId, jobId)).toBe(1);
    const history = await attemptHistory(userId, workspaceId, jobId);
    expect(history.map((h) => h.status)).toEqual(["STALE", "SUCCEEDED"]);
    expect(history.map((h) => Number(h.generation))).toEqual([1, 2]);
    // Late duplicate delivery after recovery converges without new effects.
    expect(await processImportJob(pool, jobId)).toBe("duplicate-terminal-noop");
    expect(await resultCount(userId, workspaceId, jobId)).toBe(1);
  }, 60_000);

  it("death after checkpoint resumes from PG truth with the checkpoint visible in history", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-rec-b");
    const { jobId } = await accept(base, cookie, workspaceId);
    await dispatchOutbox(pool, queue);
    await spawnFaultChild({ userId, workspaceId, jobId, phase: "after-checkpoint" });
    expect(await reclaimAndFinish(jobId, "recovery-b")).toBe("applied");
    expect(await resultCount(userId, workspaceId, jobId)).toBe(1);
    const history = await attemptHistory(userId, workspaceId, jobId);
    expect(history.map((h) => h.status)).toEqual(["STALE", "SUCCEEDED"]);
    // The superseded attempt kept the checkpoint it reached before death.
    expect(history[0].checkpoint_stage).toBe("checkpoint-a");
    expect(history[1].checkpoint_stage).toBe("checkpoint-b");
  }, 60_000);

  it("death after effect commit converges without a second effect", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-rec-c");
    const { jobId } = await accept(base, cookie, workspaceId);
    await dispatchOutbox(pool, queue);
    await spawnFaultChild({ userId, workspaceId, jobId, phase: "after-effect" });
    // Effect already committed: recovery is a terminal noop, history keeps
    // the single successful attempt, and no child process remains.
    expect(await processImportJob(pool, jobId)).toBe("duplicate-terminal-noop");
    expect(await jobStatus(userId, workspaceId, jobId)).toBe("SUCCEEDED");
    expect(await resultCount(userId, workspaceId, jobId)).toBe(1);
    expect((await attemptHistory(userId, workspaceId, jobId)).map((h) => h.status)).toEqual(["SUCCEEDED"]);
  }, 60_000);

  it("a replacement generation rejects late writes from the old attempt; concurrent redelivery has one winner", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-rec-d");
    const { jobId } = await accept(base, cookie, workspaceId);
    const route = await resolveJobRoute(pool, jobId);
    const full = { ...route!, jobId };
    const first = await claimAttempt(pool, full, "worker-old", FAULT_LEASE_MS);
    // Concurrent redelivery while the lease is live cannot steal the job.
    await expect(claimAttempt(pool, full, "worker-race", FAULT_LEASE_MS)).rejects.toMatchObject({ code: "lease_held" });
    // A stale heartbeat reports false instead of extending ownership.
    expect(await heartbeatAttempt(pool, full, first.attemptId)).toBe(true);
    await new Promise((r) => setTimeout(r, FAULT_LEASE_MS + 300));
    const second = await claimAttempt(pool, full, "worker-new", FAULT_LEASE_MS);
    expect(second.generation).toBe(first.generation + 1);
    expect(await heartbeatAttempt(pool, full, first.attemptId)).toBe(false);
    // The old worker finishing late cannot publish: every write is fenced.
    const late = { attemptId: first.attemptId, generation: first.generation };
    expect(await checkpointAttempt(pool, full, late, "checkpoint-a")).toMatchObject({ ok: false, reason: "stale_attempt" });
    expect(await commitEffectFenced(pool, full, late)).toMatchObject({ ok: false, reason: "stale_attempt" });
    expect(await resultCount(userId, workspaceId, jobId)).toBe(0);
    // The winning generation publishes exactly once.
    const win = { attemptId: second.attemptId, generation: second.generation };
    expect(await checkpointAttempt(pool, full, win, "checkpoint-a")).toMatchObject({ ok: true });
    expect(await commitEffectFenced(pool, full, win)).toMatchObject({ ok: true });
    expect(await resultCount(userId, workspaceId, jobId)).toBe(1);
    expect((await attemptHistory(userId, workspaceId, jobId)).map((h) => h.status)).toEqual(["STALE", "SUCCEEDED"]);
  }, 60_000);

  it("cancel before claim wins durably and repeat cancel is idempotent", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-rec-e");
    const { jobId } = await accept(base, cookie, workspaceId);
    const first = await cancelHttp(base, cookie, workspaceId, jobId);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ status: "CANCELLED", changed: true, effectApplied: false });
    expect(typeof (first.json as { requestId: string }).requestId).toBe("string");
    // Repeat cancel reports the same durable state without new effects.
    const repeat = await cancelHttp(base, cookie, workspaceId, jobId);
    expect(repeat.status).toBe(200);
    expect(repeat.json).toMatchObject({ status: "CANCELLED", changed: false, effectApplied: false });
    // Cancelled work is consumed, never dispatched; late delivery is a noop.
    const swept = await reconcileTransport(pool, queue);
    expect(swept.enqueued).toBe(0);
    expect(await processImportJob(pool, jobId)).toBe("duplicate-terminal-noop");
    expect(await resultCount(userId, workspaceId, jobId)).toBe(0);
    // Cancellation frees the fairness cap: new work is accepted.
    const next = await accept(base, cookie, workspaceId);
    expect([200, 201]).toContain(next.status);
    // Direct domain cancel agrees with HTTP.
    expect(await cancelJob(pool, { userId, workspaceId }, next.jobId)).toMatchObject({ status: "CANCELLED", changed: true });
  });

  it("cancel racing final publication wins the fence; committed effects are never undone", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-rec-f");
    const { jobId } = await accept(base, cookie, workspaceId);
    await dispatchOutbox(pool, queue);
    const route = await resolveJobRoute(pool, jobId);
    const full = { ...route!, jobId };
    const claim = await claimAttempt(pool, full, "worker-racy", 5000);
    const pick = { attemptId: claim.attemptId, generation: claim.generation };
    expect(await checkpointAttempt(pool, full, pick, "checkpoint-a")).toMatchObject({ ok: true });
    // Cancel lands after the checkpoint but before the final publish.
    const started = Date.now();
    const cancelled = await cancelHttp(base, cookie, workspaceId, jobId);
    expect(cancelled.json).toMatchObject({ status: "CANCEL_REQUESTED", effectApplied: false });
    const published = await commitEffectFenced(pool, full, pick);
    expect(published).toMatchObject({ ok: false, reason: "cancelled" });
    expect(await resultCount(userId, workspaceId, jobId)).toBe(0);
    // Cancellation is visible on read immediately after the atomic boundary.
    const read = await readJobHttp(base, cookie, workspaceId, jobId);
    expect(read.json).toMatchObject({ job: { status: "CANCELLED" } });
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await attemptHistory(userId, workspaceId, jobId)).map((h) => h.status)).toEqual(["CANCELLED"]);
    // Cancelling a SUCCEEDED job is an idempotent no-op reporting the effect.
    const done = await accept(base, cookie, workspaceId);
    expect(await processImportJob(pool, done.jobId)).toBe("applied");
    const afterTerminal = await cancelHttp(base, cookie, workspaceId, done.jobId);
    expect(afterTerminal.status).toBe(200);
    expect(afterTerminal.json).toMatchObject({ status: "SUCCEEDED", changed: false, effectApplied: true });
  });

  it("complete Redis loss reconstructs eligible work only; tenant-B sentinels are untouched", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "synthetic-rec-g-a");
    const b = await setupWorkspace(base, "synthetic-rec-g-b");
    // Tenant B owns sentinel accounts and one job it cancels (stays dead).
    const bAcct = await (
      await fetch(`${base}/api/accounts`, {
        method: "POST",
        headers: { cookie: b.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: b.workspaceId, name: "Sentinel Checking" }),
      })
    ).json();
    const bDead = await accept(base, b.cookie, b.workspaceId);
    expect((await cancelHttp(base, b.cookie, b.workspaceId, bDead.jobId)).status).toBe(200);
    const aLive = await accept(base, a.cookie, a.workspaceId);
    const aDone = await accept(base, a.cookie, a.workspaceId);
    await dispatchOutbox(pool, queue);
    expect(await processImportJob(pool, aDone.jobId)).toBe("applied");
    // Lose the entire dedicated Redis DB; PG truth must rebuild transport.
    const admin = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    try {
      await admin.flushdb();
    } finally {
      admin.disconnect();
    }
    expect(redisDb).not.toBe(0);
    const recovered = await reconcileTransport(pool, queue);
    expect(recovered.enqueued).toBeGreaterThanOrEqual(1);
    // Terminal (aDone) and cancelled (bDead) work is never rebuilt.
    const terminalKey = await scoped(a.userId, a.workspaceId, async (client) => {
      const r = await client.query("SELECT id FROM outbox_events WHERE workspace_id = $1 AND aggregate_id = $2", [a.workspaceId, aDone.jobId]);
      return (r.rows[0] as { id: string }).id;
    });
    expect(await queue.getJob(`outbox-${terminalKey}`)).toBeUndefined();
    expect(await processImportJob(pool, aLive.jobId)).toBe("applied");
    expect(await resultCount(a.userId, a.workspaceId, aLive.jobId)).toBe(1);
    expect(await resultCount(a.userId, a.workspaceId, aDone.jobId)).toBe(1);
    // Tenant B is byte-identical: sentinel account intact, no jobs leaked in.
    const bAccts = await scoped(b.userId, b.workspaceId, async (client) => {
      const r = await client.query("SELECT id, name FROM accounts WHERE workspace_id = $1 ORDER BY created_at", [b.workspaceId]);
      return r.rows as { id: string; name: string }[];
    });
    expect(bAccts).toEqual([{ id: (bAcct as { id: string }).id, name: "Sentinel Checking" }]);
    const bJobs = await scoped(b.userId, b.workspaceId, async (client) => {
      const r = await client.query("SELECT count(*)::int AS n FROM background_jobs WHERE workspace_id = $1 AND status <> 'CANCELLED'", [b.workspaceId]);
      return (r.rows[0] as { n: number }).n;
    });
    expect(bJobs).toBe(0);
  });

  it("a real worker delivery completes end to end and closes gracefully", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-rec-h");
    const service = createWorkerService({
      databaseUrl: withDatabase(appDbUrl, "moneo_e02_recovery"),
      redisUrl,
      leaseMs: 5000,
      workerId: "e02-s02-probe",
    });
    try {
      await service.worker.waitUntilReady();
      const { jobId } = await accept(base, cookie, workspaceId);
      await service.dispatchOnce();
      await waitFor(async () => (await jobStatus(userId, workspaceId, jobId)) === "SUCCEEDED", 15_000, "worker-delivered success");
      expect(await resultCount(userId, workspaceId, jobId)).toBe(1);
      const history = await attemptHistory(userId, workspaceId, jobId);
      expect(history.map((h) => h.status)).toEqual(["SUCCEEDED"]);
      expect(history[0].checkpoint_stage).toBe("checkpoint-b");
    } finally {
      await service.close();
    }
  }, 60_000);

  it("100 lost jobs recover within 30 seconds through the reconciler", async () => {
    const base = await startApp();
    const started = Date.now();
    const jobIds: string[] = [];
    for (let wave = 0; wave < 50; wave++) {
      const wav = await setupWorkspace(base, `synthetic-rec-i-${wave}`);
      const first = await accept(base, wav.cookie, wav.workspaceId);
      const second = await accept(base, wav.cookie, wav.workspaceId);
      expect([200, 201]).toContain(first.status);
      expect([200, 201]).toContain(second.status);
      jobIds.push(first.jobId, second.jobId);
    }
    expect(jobIds.length).toBe(100);
    await dispatchOutbox(pool, queue, 50);
    await dispatchOutbox(pool, queue, 50);
    const admin = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    try {
      await admin.flushdb();
    } finally {
      admin.disconnect();
    }
    let enqueued = 0;
    for (let guard = 0; guard < 10; guard++) {
      const swept = await reconcileTransport(pool, queue, 100);
      enqueued += swept.enqueued;
      if (swept.enqueued === 0) break;
    }
    expect(enqueued).toBeGreaterThanOrEqual(100);
    for (const jobId of jobIds) {
      expect(await processImportJob(pool, jobId)).toBe("applied");
    }
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 120_000);

  it("status and cancel responses carry stable text plus request id; strangers get uniform errors", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "synthetic-rec-j-a");
    const b = await setupWorkspace(base, "synthetic-rec-j-b");
    const { jobId } = await accept(base, a.cookie, a.workspaceId);
    const read = await readJobHttp(base, a.cookie, a.workspaceId, jobId);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ job: { status: "QUEUED" } });
    expect(typeof (read.json as { requestId: string }).requestId).toBe("string");
    expect(typeof ((read.json as { job: { id: string } }).job.id)).toBe("string");
    const anon = await fetch(`${base}/api/workspaces/${a.workspaceId}/jobs/${jobId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(anon.status).toBe(401);
    const foreign = await cancelHttp(base, b.cookie, a.workspaceId, jobId);
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual({ error: "not_found" });
    const missing = await cancelHttp(base, b.cookie, b.workspaceId, randomUUID());
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: "not_found" });
    // Malformed ids are indistinguishable from missing ones.
    const malformed = await readJobHttp(base, a.cookie, a.workspaceId, "not-a-uuid");
    expect(malformed.status).toBe(404);
    expect(malformed.json).toEqual({ error: "not_found" });
  });

  it("reconciler and dispatcher batch caps stay bounded", async () => {
    await expect(reconcileTransport(pool, queue, 101)).rejects.toThrow("reconcile limit out of range");
    await expect(dispatchOutbox(pool, queue, 51)).rejects.toThrow("dispatch limit out of range");
    expect((await reconcileTransport(pool, queue, 100)).enqueued).toBeGreaterThanOrEqual(0);
  });
});
