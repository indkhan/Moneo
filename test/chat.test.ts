// E04-S02 persistent chat and worker-owned model loop: threads/turns over
// tenant HTTP, one durable worker owning generation, reconnect from a saved
// cursor, SIGKILL recovery at claim/output boundaries with at most one
// published turn, same-key replay convergence, tenant uniformity, cancel and
// retry within S01 accounting. Real PostgreSQL (own `moneo_e04_chat` DB) and
// real Redis (dedicated logical DB 9, loopback-guarded; only it is flushed);
// deterministic scripted transports only — no live provider.

import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { Redis } from "ioredis";
import type { Queue, Worker } from "bullmq";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter } from "../apps/web/src/tenancy.ts";
import { withTenant } from "../apps/web/src/tenancy.ts";
import { withDatabase } from "../apps/web/src/db.ts";
import {
  dispatchOutbox,
  jobsQueue,
  readJob,
  resolveJobRoute,
  startJobsWorker,
  type JobPayload,
} from "../apps/web/src/jobs.ts";
import { reconcileTransport } from "../apps/web/src/job-recovery.ts";
import {
  cancelTurn,
  getThread,
  processChatJob,
  readActivity,
  retryTurn,
  sendTurn,
} from "../apps/web/src/chat.ts";
import type { DispatchTransport } from "../apps/web/src/ai-dispatch.ts";
import { ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
let appDbUrl: string;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
const tag = randomBytes(4).toString("hex");
const FAULT_LEASE_MS = 2000;

let redisUrl: string;
let queue: Queue<JobPayload>;
let bullWorker: Worker<JobPayload, string> | null = null;
let currentTransport: DispatchTransport | null = null;

function chatRedisUrl(): string {
  const base = env("E04-S02", "REDIS_URL");
  const u = new URL(base);
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
    throw new Error("E04-S02 refused: REDIS_URL must point at the local disposable Redis.");
  }
  const db = process.env["CHAT_REDIS_DB"] ?? "9";
  if (!/^\d+$/.test(db) || Number(db) < 0 || Number(db) > 15) throw new Error("E04-S02 misconfigured: CHAT_REDIS_DB must be 0-15.");
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

async function setupWorkspace(base: string, sub: string, suffix: string): Promise<{ cookie: string; userId: string; workspaceId: string }> {
  const cookie = await login(base, sub);
  const ws = (await (await fetch(`${base}/api/workspaces`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `W-${suffix}`, baseCurrency: "EUR" }),
  })).json()) as { id: string };
  const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub])).rows[0] as { id: string }).id;
  return { cookie, userId, workspaceId: ws.id };
}

async function call(method: string, url: string, cookie: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as unknown };
}

async function scoped<T>(userId: string, workspaceId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(pool, { userId, workspaceId }, work);
}

const okTransport = (text: string, calls: { count: number }): DispatchTransport => async () => {
  calls.count += 1;
  return { httpStatus: 200, bodyText: text, inputTokens: 50, outputTokens: 25, model: "double" };
};

const failTransport = (status: number | null, calls: { count: number }): DispatchTransport => async () => {
  calls.count += 1;
  return { httpStatus: status, bodyText: null, inputTokens: null, outputTokens: null, model: "double" };
};

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

type FaultPhase = "after-claim" | "after-output";

function spawnFaultChild(opts: { userId: string; workspaceId: string; jobId: string; phase: FaultPhase; text: string }): Promise<{ signal: string | null }> {
  // Kill timing comes from PG truth (vitest buffers console output until the
  // hanging test ends, so stdio markers are unreliable): once the child
  // persists the phase boundary, SIGKILL the real process. Reads use the
  // known test membership.
  const { userId, workspaceId, jobId, phase, text } = opts;
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", "test/helpers/chat-fault-child.test.ts", "--pool=threads", "--maxWorkers=1"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          E04_CHAT_DB_URL: appDbUrl,
          E04_CHAT_JOB: jobId,
          E04_CHAT_PHASE: phase,
          E04_CHAT_LEASE_MS: String(FAULT_LEASE_MS),
          E04_CHAT_TEXT: text,
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
    const readState = async (): Promise<boolean> => {
      return scoped(userId, workspaceId, async (client) => {
        if (phase === "after-claim") {
          const found = await client.query("SELECT 1 FROM chat_attempts a JOIN chat_turns t ON t.workspace_id = a.workspace_id AND t.id = a.turn_id WHERE a.workspace_id = $1 AND t.job_id = $2 AND a.status = 'running'", [
            workspaceId,
            jobId,
          ]);
          return (found.rowCount ?? 0) > 0;
        }
        const found = await client.query("SELECT 1 FROM chat_attempts a JOIN chat_turns t ON t.workspace_id = a.workspace_id AND t.id = a.turn_id WHERE a.workspace_id = $1 AND t.job_id = $2 AND a.output_text IS NOT NULL", [
          workspaceId,
          jobId,
        ]);
        return (found.rowCount ?? 0) > 0;
      });
    };
    const poll = setInterval(() => {
      void (async () => {
        if (settled) return;
        try {
          if (await readState()) {
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
          if (await readState()) resolve({ signal });
          else reject(new Error(`fault child exited before persisting ${phase}: ${stderr.trim().slice(0, 400) || "no stderr"}`));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  });
}

beforeAll(async () => {
  process.env["APP_ENV"] = "test";
  appDbUrl = withDatabase(env("E04-S02", "DATABASE_URL"), "moneo_e04_chat");
  pool = await ensureTestPool("E04-S02", "moneo_e04_chat", ["chat_activity", "chat_attempts", "chat_turns", "chat_threads", "ai_dispatch_usage", "ai_dispatch_reservations", "ai_dispatch_budgets", "manual_transactions", "balance_snapshots", "balance_audit", "mapping_provider_usage", "mapping_provider_reservations", "mapping_proposals", "mapping_profiles", "review_decisions", "source_links", "transactions", "import_commit_batches", "parsed_observations", "source_objects", "imports", "data_sources", "background_job_attempts", "job_dispatch_index", "outbox_events", "background_job_results", "background_jobs", "ai_dispatch_permits", "ai_exclusions", "ai_policies", "command_operations", "accounts", "workspace_members", "workspaces", "users", "app_sessions"]);
  stub = await startStubIssuer();
  redisUrl = chatRedisUrl();
  queue = jobsQueue(redisUrl);
}, 60_000);

afterAll(async () => {
  if (bullWorker) await bullWorker.close();
  if (queue) await queue.close();
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e04-s02 persistent chat and worker loop", () => {
  it("send returns an accepted durable turn and job; reconnect resumes ordered activity and the final turn", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-a-${tag}`, "a");
    const claims = { userId, workspaceId };
    const thread = (await call("POST", `${base}/api/chat/threads`, cookie, { workspaceId, title: "synthetic" })).json as { id: string };
    const sent = (await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "synthetic question", idempotencyKey: randomUUID() }));
    expect(sent.status).toBe(202);
    const body = sent.json as { userTurn: { id: string }; assistantTurn: { id: string }; jobId: string };
    // Reconnect from the beginning: user turn + queued assistant first.
    const first = (await call("GET", `${base}/api/chat/threads/${thread.id}/activity?workspaceId=${workspaceId}&after=0&limit=100`, cookie)).json as {
      events: { seq: string; kind: string }[];
      nextCursor: string;
    };
    expect(first.events.map((e) => e.kind)).toEqual(["user-turn", "assistant-queued"]);
    const calls = { count: 0 };
    const outcome = await processChatJob(pool, body.jobId, okTransport("synthetic answer", calls), { workerId: "chat-test", leaseMs: 5000 });
    expect(outcome).toBe("applied");
    const view = await getThread(pool, claims, thread.id);
    const assistant = view!.turns.find((t) => t.role === "assistant");
    expect(assistant).toMatchObject({ status: "completed", body: "synthetic answer" });
    // Reconnect from the saved cursor: only the new running/published events,
    // then the final turn on the thread read.
    const rest = (await call("GET", `${base}/api/chat/threads/${thread.id}/activity?workspaceId=${workspaceId}&after=${first.nextCursor}&limit=100`, cookie)).json as {
      events: { seq: string; kind: string }[];
      nextCursor: string;
    };
    expect(rest.events.map((e) => e.kind)).toEqual(["assistant-running", "assistant-published"]);
    expect(Number(rest.events[0].seq)).toBeGreaterThan(Number(first.nextCursor));
    // Cursor pages chain without overlap.
    const page = await readActivity(pool, claims, thread.id, 0, 2);
    expect(page.events.map((e) => e.kind)).toEqual(["user-turn", "assistant-queued"]);
    const page2 = await readActivity(pool, claims, thread.id, Number(page.nextCursor), 100);
    expect(page2.events.map((e) => e.kind)).toEqual(["assistant-running", "assistant-published"]);
  });

  it("concurrent sends admit exactly one generation with typed busy errors only", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, `synthetic-chat-b1-${tag}`, "b1");
    const thread = (await call("POST", `${base}/api/chat/threads`, cookie, { workspaceId })).json as { id: string };
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) => call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: `racer ${i}`, idempotencyKey: randomUUID() })),
    );
    const won = results.filter((r) => r.status === 202);
    const busy = results.filter((r) => r.status === 409 && (r.json as { error?: string }).error === "thread_busy");
    expect(won).toHaveLength(1);
    expect(busy).toHaveLength(3);
    // No raw 500 escapes: every outcome is a typed success or busy conflict.
    for (const r of results) expect([202, 409]).toContain(r.status);
  });

  it("real BullMQ delivery completes the turn; duplicate redelivery is a noop", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-q-${tag}`, "q");
    const claims = { userId, workspaceId };
    currentTransport = okTransport("queued answer", { count: 0 });
    bullWorker = startJobsWorker(redisUrl, async (job) => {
      const workerRoute = await resolveJobRoute(pool, job.data.backgroundJobId);
      if (!workerRoute) return "noop-route";
      const view = await readJob(pool, { userId: workerRoute.acceptedBy, workspaceId: workerRoute.workspaceId }, job.data.backgroundJobId);
      if (view?.jobType !== "chat.generate") return "noop-type";
      return processChatJob(pool, job.data.backgroundJobId, currentTransport, { workerId: "chat-test-worker", leaseMs: 5000 });
    }, 2);
    const thread = (await call("POST", `${base}/api/chat/threads`, cookie, { workspaceId })).json as { id: string };
    const sent = (await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "via queue", idempotencyKey: randomUUID() })).json as {
      assistantTurn: { id: string };
      jobId: string;
    };
    await dispatchOutbox(pool, queue);
    await waitFor(async () => {
      const view = await getThread(pool, claims, thread.id);
      return view!.turns.find((t) => t.id === sent.assistantTurn.id)?.status === "completed";
    }, 20_000, "queued generation to complete");
    const done = await getThread(pool, claims, thread.id);
    expect(done!.turns.find((t) => t.id === sent.assistantTurn.id)).toMatchObject({ status: "completed", body: "queued answer" });
    // Duplicate redelivery converges without a second turn or second publish.
    const again = await processChatJob(pool, sent.jobId, okTransport("second answer", { count: 0 }), { workerId: "chat-test", leaseMs: 5000 });
    expect(again).toBe("duplicate-terminal-noop");
    const unchanged = await getThread(pool, claims, thread.id);
    expect(unchanged!.turns.filter((t) => t.role === "assistant")).toHaveLength(1);
    expect(unchanged!.turns.find((t) => t.role === "assistant")?.body).toBe("queued answer");
    await bullWorker.close();
    bullWorker = null;
  });

  it("SIGKILL after claim reclaims with a new generation and publishes exactly once", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-k1-${tag}`, "k1");
    const claims = { userId, workspaceId };
    const thread = (await call("POST", `${base}/api/chat/threads`, cookie, { workspaceId })).json as { id: string };
    const sent = (await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "kill early", idempotencyKey: randomUUID() })).json as {
      assistantTurn: { id: string };
      jobId: string;
    };
    await spawnFaultChild({ userId, workspaceId, jobId: sent.jobId, phase: "after-claim", text: "unused" });
    await new Promise((r) => setTimeout(r, FAULT_LEASE_MS + 800));
    const calls = { count: 0 };
    const outcome = await processChatJob(pool, sent.jobId, okTransport("recovered answer", calls), { workerId: "chat-test", leaseMs: 5000 });
    expect(outcome).toBe("applied");
    expect(calls.count).toBe(1);
    const view = await getThread(pool, claims, thread.id);
    const assistants = view!.turns.filter((t) => t.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ status: "completed", body: "recovered answer" });
    expect(view!.attempts.map((a) => `${a.generation}:${a.status}`).sort()).toEqual(["1:interrupted", "2:published"]);
    // The dead generation reserved nothing (killed before dispatch): only the
    // recovery's reconciled reservation remains, never a leaked RESERVED row.
    const leaked = await scoped(userId, workspaceId, async (client) => {
      const r = await client.query("SELECT status FROM ai_dispatch_reservations WHERE workspace_id = $1", [workspaceId]);
      return (r.rows as { status: string }[]).map((row) => row.status).sort();
    });
    expect(leaked).toEqual(["RECONCILED"]);
  });

  it("SIGKILL after output publishes exactly once with the recovered text only", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-k2-${tag}`, "k2");
    const claims = { userId, workspaceId };
    const thread = (await call("POST", `${base}/api/chat/threads`, cookie, { workspaceId })).json as { id: string };
    const sent = (await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "kill late", idempotencyKey: randomUUID() })).json as {
      assistantTurn: { id: string };
      jobId: string;
    };
    await spawnFaultChild({ userId, workspaceId, jobId: sent.jobId, phase: "after-output", text: "dead generation text" });
    await new Promise((r) => setTimeout(r, FAULT_LEASE_MS + 800));
    const calls = { count: 0 };
    const outcome = await processChatJob(pool, sent.jobId, okTransport("live generation text", calls), { workerId: "chat-test", leaseMs: 5000 });
    expect(outcome).toBe("applied");
    const view = await getThread(pool, claims, thread.id);
    const assistants = view!.turns.filter((t) => t.role === "assistant");
    expect(assistants).toHaveLength(1);
    // The recovered generation dispatches fresh: its own text publishes, the
    // dead attempt's bytes are never concatenated or promoted.
    expect(assistants[0]).toMatchObject({ status: "completed", body: "live generation text" });
    expect(view!.attempts.map((a) => `${a.generation}:${a.status}`).sort()).toEqual(["1:interrupted", "2:published"]);
    // The dead generation's RESERVED reservation settles PENDING-held at
    // supersede time: its slot is freed but the money stays honestly held.
    const held = await scoped(userId, workspaceId, async (client) => {
      const r = await client.query("SELECT status FROM ai_dispatch_reservations WHERE workspace_id = $1", [workspaceId]);
      return (r.rows as { status: string }[]).map((row) => row.status).sort();
    });
    expect(held).toEqual(["PENDING", "RECONCILED"]);
  });

  it("same-key replay converges on one turn pair and one job", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-r-${tag}`, "r");
    const claims = { userId, workspaceId };
    const thread = (await call("POST", `${base}/api/chat/threads`, cookie, { workspaceId })).json as { id: string };
    const key = randomUUID();
    const first = await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "replay me", idempotencyKey: key });
    const second = await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "replay me", idempotencyKey: key });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((second.json as { jobId: string }).jobId).toBe((first.json as { jobId: string }).jobId);
    expect((second.json as { replayed: boolean }).replayed).toBe(true);
    const view = await getThread(pool, claims, thread.id);
    expect(view!.turns).toHaveLength(2);
    const clash = await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "different bytes", idempotencyKey: key });
    expect(clash.status).toBe(409);
    expect(clash.json).toMatchObject({ error: "idempotency_reuse" });
  });

  it("tenant-swapped ids are uniformly not found and unscoped reads return no rows", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, `synthetic-chat-ta-${tag}`, "ta");
    const b = await setupWorkspace(base, `synthetic-chat-tb-${tag}`, "tb");
    const thread = (await call("POST", `${base}/api/chat/threads`, b.cookie, { workspaceId: b.workspaceId })).json as { id: string };
    const sent = (await call("POST", `${base}/api/chat/threads/${thread.id}/send`, b.cookie, {
      workspaceId: b.workspaceId,
      body: "private",
      idempotencyKey: randomUUID(),
    })).json as { assistantTurn: { id: string }; jobId: string };
    const get = await call("GET", `${base}/api/chat/threads/${thread.id}?workspaceId=${a.workspaceId}`, a.cookie);
    expect(get.status).toBe(404);
    const send = await call("POST", `${base}/api/chat/threads/${thread.id}/send`, a.cookie, { workspaceId: a.workspaceId, body: "x", idempotencyKey: randomUUID() });
    expect(send.status).toBe(404);
    const activity = await call("GET", `${base}/api/chat/threads/${thread.id}/activity?workspaceId=${a.workspaceId}&after=0`, a.cookie);
    expect(activity.status).toBe(404);
    const cancel = await call("POST", `${base}/api/chat/turns/${sent.assistantTurn.id}/cancel`, a.cookie, { workspaceId: a.workspaceId });
    expect(cancel.status).toBe(404);
    const retry = await call("POST", `${base}/api/chat/turns/${sent.assistantTurn.id}/retry`, a.cookie, { workspaceId: a.workspaceId, idempotencyKey: randomUUID() });
    expect(retry.status).toBe(404);
    const missing = await call("GET", `${base}/api/chat/threads/${randomUUID()}?workspaceId=${a.workspaceId}`, a.cookie);
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual(get.json);
    const unscoped = await pool.query("SELECT count(*)::int AS n FROM chat_turns");
    expect((unscoped.rows[0] as { n: number }).n).toBe(0);
    const unscopedActivity = await pool.query("SELECT count(*)::int AS n FROM chat_activity");
    expect((unscopedActivity.rows[0] as { n: number }).n).toBe(0);
  });

  it("cancel before dispatch prevents publish; cancel of a finished turn is a noop", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-c-${tag}`, "c");
    const claims = { userId, workspaceId };
    const thread = (await call("POST", `${base}/api/chat/threads`, cookie, { workspaceId })).json as { id: string };
    const sent = (await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "stop me", idempotencyKey: randomUUID() })).json as {
      assistantTurn: { id: string };
      jobId: string;
    };
    const cancelled = await call("POST", `${base}/api/chat/turns/${sent.assistantTurn.id}/cancel`, cookie, { workspaceId });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toMatchObject({ status: "cancelled", changed: true });
    const calls = { count: 0 };
    const outcome = await processChatJob(pool, sent.jobId, okTransport("too late", calls), { workerId: "chat-test", leaseMs: 5000 });
    expect(outcome).toBe("duplicate-terminal-noop");
    expect(calls.count).toBe(0);
    const view = await getThread(pool, claims, thread.id);
    expect(view!.turns.find((t) => t.id === sent.assistantTurn.id)?.status).toBe("cancelled");
    // A finished turn cannot be cancelled again into a new state.
    const sent2 = (await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "finish me", idempotencyKey: randomUUID() })).json as {
      assistantTurn: { id: string };
      jobId: string;
    };
    await processChatJob(pool, sent2.jobId, okTransport("done", { count: 0 }), { workerId: "chat-test", leaseMs: 5000 });
    const noop = await call("POST", `${base}/api/chat/turns/${sent2.assistantTurn.id}/cancel`, cookie, { workspaceId });
    expect(noop.json).toMatchObject({ status: "completed", changed: false });
  });

  it("retry of an interrupted turn starts a visibly separate attempt and completes", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-rt-${tag}`, "rt");
    const claims = { userId, workspaceId };
    const thread = (await call("POST", `${base}/api/chat/threads`, cookie, { workspaceId })).json as { id: string };
    const sent = (await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "flaky", idempotencyKey: randomUUID() })).json as {
      assistantTurn: { id: string };
      jobId: string;
    };
    const dead = { count: 0 };
    await processChatJob(pool, sent.jobId, failTransport(503, dead), { workerId: "chat-test", leaseMs: 5000 });
    await processChatJob(pool, sent.jobId, failTransport(503, dead), { workerId: "chat-test", leaseMs: 5000 });
    const interrupted = await getThread(pool, claims, thread.id);
    expect(interrupted!.turns.find((t) => t.id === sent.assistantTurn.id)?.status).toBe("interrupted");
    const retried = (await call("POST", `${base}/api/chat/turns/${sent.assistantTurn.id}/retry`, cookie, { workspaceId, idempotencyKey: randomUUID() }));
    expect(retried.status).toBe(200);
    const retryBody = retried.json as { assistantTurn: { id: string }; jobId: string };
    expect(retryBody.assistantTurn.id).toBe(sent.assistantTurn.id);
    expect(retryBody.jobId).not.toBe(sent.jobId);
    await processChatJob(pool, retryBody.jobId, okTransport("recovered", { count: 0 }), { workerId: "chat-test", leaseMs: 5000 });
    const view = await getThread(pool, claims, thread.id);
    expect(view!.turns.find((t) => t.id === sent.assistantTurn.id)).toMatchObject({ status: "completed", body: "recovered" });
    expect(view!.attempts.map((a) => a.status).sort()).toEqual(["interrupted", "published"]);
    const activity = await readActivity(pool, claims, thread.id, 0, 100);
    expect(activity.events.map((e) => e.kind)).toEqual(["user-turn", "assistant-queued", "assistant-running", "assistant-interrupted", "retry", "assistant-running", "assistant-published"]);
  });

  it("terminal provider failure fails the turn and the job without retry", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-f-${tag}`, "f");
    const claims = { userId, workspaceId };
    const thread = (await call("POST", `${base}/api/chat/threads`, cookie, { workspaceId })).json as { id: string };
    const sent = (await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "denied", idempotencyKey: randomUUID() })).json as {
      assistantTurn: { id: string };
      jobId: string;
    };
    const calls = { count: 0 };
    await processChatJob(pool, sent.jobId, failTransport(401, calls), { workerId: "chat-test", leaseMs: 5000 });
    expect(calls.count).toBe(1);
    const view = await getThread(pool, claims, thread.id);
    expect(view!.turns.find((t) => t.id === sent.assistantTurn.id)?.status).toBe("failed");
    const job = await readJob(pool, claims, sent.jobId);
    expect(job?.status).toBe("FAILED_FINAL");
  });

  it("one active generation per thread; sequential turns each complete", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-m-${tag}`, "m");
    const claims = { userId, workspaceId };
    const thread = (await call("POST", `${base}/api/chat/threads`, cookie, { workspaceId })).json as { id: string };
    const first = await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "first", idempotencyKey: randomUUID() });
    expect(first.status).toBe(202);
    const busy = await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "second", idempotencyKey: randomUUID() });
    expect(busy.status).toBe(409);
    expect(busy.json).toMatchObject({ error: "thread_busy" });
    const bodies = ["first answer", "second answer", "third answer"];
    await processChatJob(pool, (first.json as { jobId: string }).jobId, okTransport(bodies[0], { count: 0 }), { workerId: "chat-test", leaseMs: 5000 });
    for (const text of bodies.slice(1)) {
      const sent = (await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: text, idempotencyKey: randomUUID() })).json as { jobId: string };
      await processChatJob(pool, sent.jobId, okTransport(`${text}`, { count: 0 }), { workerId: "chat-test", leaseMs: 5000 });
    }
    const view = await getThread(pool, claims, thread.id);
    expect(view!.turns.filter((t) => t.role === "assistant" && t.status === "completed")).toHaveLength(3);
  });

  it("Redis loss rebuilds the queued generation from PG without duplication", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-rl-${tag}`, "rl");
    const claims = { userId, workspaceId };
    currentTransport = okTransport("after redis loss", { count: 0 });
    const local = startJobsWorker(redisUrl, async (job) => {
      const workerRoute = await resolveJobRoute(pool, job.data.backgroundJobId);
      if (!workerRoute) return "noop-route";
      return processChatJob(pool, job.data.backgroundJobId, currentTransport, { workerId: "chat-test-worker", leaseMs: 5000 });
    }, 2);
    try {
      const thread = (await call("POST", `${base}/api/chat/threads`, cookie, { workspaceId })).json as { id: string };
      const sent = (await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "survive flush", idempotencyKey: randomUUID() })).json as {
        assistantTurn: { id: string };
        jobId: string;
      };
      await dispatchOutbox(pool, queue);
      await new Redis(redisUrl).flushdb();
      await reconcileTransport(pool, queue);
      await waitFor(async () => {
        const view = await getThread(pool, claims, thread.id);
        return view!.turns.find((t) => t.id === sent.assistantTurn.id)?.status === "completed";
      }, 20_000, "redis-loss generation to complete");
      const view = await getThread(pool, claims, thread.id);
      expect(view!.turns.filter((t) => t.role === "assistant")).toHaveLength(1);
      expect(view!.turns.find((t) => t.id === sent.assistantTurn.id)).toMatchObject({ status: "completed", body: "after redis loss" });
    } finally {
      await local.close();
    }
  });

  it("oversized bodies and bad cursors fail typed without state changes", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-v-${tag}`, "v");
    const claims = { userId, workspaceId };
    const thread = (await call("POST", `${base}/api/chat/threads`, cookie, { workspaceId })).json as { id: string };
    const big = await call("POST", `${base}/api/chat/threads/${thread.id}/send`, cookie, { workspaceId, body: "x".repeat(32 * 1024 + 1), idempotencyKey: randomUUID() });
    expect(big.status).toBe(400);
    expect(big.json).toMatchObject({ error: "invalid_request" });
    const badLimit = await call("GET", `${base}/api/chat/threads/${thread.id}/activity?workspaceId=${workspaceId}&after=0&limit=101`, cookie);
    expect(badLimit.status).toBe(400);
    const badAfter = await call("GET", `${base}/api/chat/threads/${thread.id}/activity?workspaceId=${workspaceId}&after=nope&limit=10`, cookie);
    expect(badAfter.status).toBe(400);
    const view = await getThread(pool, claims, thread.id);
    expect(view!.turns).toHaveLength(0);
    // Module-level cancel/retry agree with HTTP on unknown ids.
    await expect(cancelTurn(pool, claims, randomUUID())).rejects.toThrow();
    await expect(retryTurn(pool, claims, userId, { turnId: randomUUID(), idempotencyKey: randomUUID() })).rejects.toThrow();
  });
});
