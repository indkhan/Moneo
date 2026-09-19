// E04-S01 atomic provider-dispatch budgets: barrier-started races admit only
// reservations within every limit (rejected calls never reach transport),
// success reconciles measured usage, missing/invalid usage stays PENDING with
// the full reservation held, terminal failure releases under the documented
// class, revocation after reserve fails closed, production never falls back,
// one retry only before any provider output, idempotent replay converges.
// Real PostgreSQL (own `moneo_e04_dispatch` DB, fails closed without PG);
// deterministic scripted transports only — no live provider.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter } from "../apps/web/src/tenancy.ts";
import { issuePermit, setAccountExclusion } from "../apps/web/src/ai-policy.ts";
import {
  cancelDispatch,
  dispatchModelCall,
  executeReserved,
  readDispatch,
  reserveDispatch,
  setDispatchBudget,
  DispatchError,
  type DispatchAttempt,
  type DispatchTransport,
} from "../apps/web/src/ai-dispatch.ts";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
const tag = randomBytes(4).toString("hex");

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

async function setupWorkspace(base: string, sub: string, suffix: string): Promise<{ cookie: string; userId: string; workspaceId: string; acctA: string; acctB: string }> {
  const cookie = await login(base, sub);
  const headers = { cookie, "Content-Type": "application/json" };
  const ws = (await (await fetch(`${base}/api/workspaces`, { method: "POST", headers, body: JSON.stringify({ name: `W-${suffix}`, baseCurrency: "EUR" }) })).json()) as { id: string };
  const mk = async (name: string): Promise<string> =>
    ((await (await fetch(`${base}/api/accounts`, { method: "POST", headers, body: JSON.stringify({ workspaceId: ws.id, name }) })).json()) as { id: string }).id;
  const acctA = await mk(`SENTINEL-A-${tag}-${suffix}`);
  const acctB = await mk(`SENTINEL-B-${tag}-${suffix}`);
  const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub])).rows[0] as { id: string }).id;
  return { cookie, userId, workspaceId: ws.id, acctA, acctB };
}

type ScriptStep = { ok: DispatchAttempt } | { fail: number | null } | { boom: true };

function scriptTransport(steps: ScriptStep[], calls: { count: number }): DispatchTransport {
  return async () => {
    calls.count += 1;
    const step = steps[Math.min(calls.count - 1, steps.length - 1)];
    if ("boom" in step) throw new Error("transport boom");
    if ("fail" in step) return { httpStatus: step.fail, bodyText: null, inputTokens: null, outputTokens: null, model: "double" };
    return step.ok;
  };
}

const okAttempt = (inputTokens: number | null, outputTokens: number | null): DispatchAttempt => ({
  httpStatus: 200,
  bodyText: '{"answer":"synthetic"}',
  inputTokens,
  outputTokens,
  model: "double-1",
});

// One reservation costs ceil(8000/1000)*1 + ceil(2000/1000)*4 = 16 minor.
const RESERVE_OPTS = { inputEstimate: 8000, outputCeiling: 2000, requestText: "synthetic dispatch request" };

beforeAll(async () => {
  process.env["APP_ENV"] = "test";
  pool = await ensureTestPool("E04-S01", "moneo_e04_dispatch", ["ai_dispatch_usage", "ai_dispatch_reservations", "ai_dispatch_budgets", "manual_transactions", "balance_snapshots", "balance_audit", "mapping_provider_usage", "mapping_provider_reservations", "mapping_proposals", "mapping_profiles", "review_decisions", "source_links", "transactions", "import_commit_batches", "parsed_observations", "source_objects", "imports", "data_sources", "background_job_attempts", "job_dispatch_index", "outbox_events", "background_job_results", "background_jobs", "ai_dispatch_permits", "ai_exclusions", "ai_policies", "command_operations", "accounts", "workspace_members", "workspaces", "users", "app_sessions"]);
  stub = await startStubIssuer();
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e04-s01 atomic dispatch budgets", () => {
  it("barrier-started money race admits exactly one reservation; rejected calls never reach transport", async () => {
    const base = await startApp();
    const { userId, workspaceId } = await setupWorkspace(base, `synthetic-disp-race-m-${tag}`, "m");
    const claims = { userId, workspaceId };
    await setDispatchBudget(pool, claims, { moneyMinor: "20", tokens: 400000, concurrency: 32 });
    const permits = await Promise.all(Array.from({ length: 8 }, (_, i) => issuePermit(pool, claims, `race-money-${i}`)));
    const calls = { count: 0 };
    const started = await Promise.all(
      permits.map((permit, i) =>
        reserveDispatch(pool, claims, { idempotencyKey: randomUUID(), permitId: permit.id, route: "development", purpose: `race-money-${i}`, ...RESERVE_OPTS })
          .then((r) => ({ ok: true as const, r }))
          .catch((err: unknown) => ({ ok: false as const, err })),
      ),
    );
    const won = started.filter((s) => s.ok);
    const lost = started.filter((s) => !s.ok);
    expect(won).toHaveLength(1);
    expect(won[0].ok && won[0].r.reservedCostMinor).toBe("16");
    for (const l of lost) {
      expect(l.ok).toBe(false);
      if (!l.ok) expect((l.err as DispatchError).code).toBe("budget_money");
    }
    expect(calls.count).toBe(0);
  });

  it("concurrency and token races each admit only up to their limit", async () => {
    const base = await startApp();
    const mk = async (sub: string, suffix: string, budget: { moneyMinor: string; tokens: number; concurrency: number }, n: number) => {
      const { userId, workspaceId } = await setupWorkspace(base, sub, suffix);
      const claims = { userId, workspaceId };
      await setDispatchBudget(pool, claims, budget);
      const permits = await Promise.all(Array.from({ length: n }, (_, i) => issuePermit(pool, claims, `race-${suffix}-${i}`)));
      return Promise.all(
        permits.map((permit, i) =>
          reserveDispatch(pool, claims, { idempotencyKey: randomUUID(), permitId: permit.id, route: "development", purpose: `race-${suffix}-${i}`, ...RESERVE_OPTS })
            .then(() => "ok" as const)
            .catch((err: unknown) => (err as DispatchError).code),
        ),
      );
    };
    const conc = await mk(`synthetic-disp-race-c-${tag}`, "c", { moneyMinor: "1000000", tokens: 4000000, concurrency: 2 }, 6);
    expect(conc.filter((c) => c === "ok")).toHaveLength(2);
    expect(conc.filter((c) => c === "budget_concurrency")).toHaveLength(4);
    const tok = await mk(`synthetic-disp-race-t-${tag}`, "t", { moneyMinor: "1000000", tokens: 20000, concurrency: 32 }, 6);
    expect(tok.filter((c) => c === "ok")).toHaveLength(2);
    expect(tok.filter((c) => c === "budget_tokens")).toHaveLength(4);
  });

  it("success reconciles measured usage with exact decimal-string cost", async () => {
    const base = await startApp();
    const { userId, workspaceId } = await setupWorkspace(base, `synthetic-disp-ok-${tag}`, "ok");
    const claims = { userId, workspaceId };
    const calls = { count: 0 };
    const state = await dispatchModelCall(
      pool,
      claims,
      { idempotencyKey: randomUUID(), permitId: (await issuePermit(pool, claims, "ok-purpose")).id, route: "development", purpose: "ok-purpose", ...RESERVE_OPTS },
      scriptTransport([{ ok: okAttempt(120, 60) }], calls),
    );
    // ceil(120/1000)*1 + ceil(60/1000)*4 = 1 + 4 = 5 minor.
    expect(state.reservation.status).toBe("RECONCILED");
    expect(state.reservation.attempt).toBe(1);
    expect(state.usage).toMatchObject({ status: "RECONCILED", inputTokens: 120, outputTokens: 60, reconciledCostMinor: "5", errorClass: null });
    expect(calls.count).toBe(1);
    // Replay converges: no second transport call, no second usage row.
    const again = await executeReserved(pool, claims, state.reservation.id, scriptTransport([{ ok: okAttempt(1, 1) }], calls), RESERVE_OPTS.requestText);
    expect(again.reservation.status).toBe("RECONCILED");
    expect(again.usage?.reconciledCostMinor).toBe("5");
    expect(calls.count).toBe(1);
    // One usage row per reservation: count inside tenant context (FORCE RLS
    // filters unscoped reads to zero by design — asserted below).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace', $1, true)", [workspaceId]);
      const rows = await client.query("SELECT count(*)::int AS n FROM ai_dispatch_usage WHERE reservation_id = $1", [state.reservation.id]);
      expect((rows.rows[0] as { n: number }).n).toBe(1);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("missing usage stays PENDING with the full reservation held, never zero", async () => {
    const base = await startApp();
    const { userId, workspaceId } = await setupWorkspace(base, `synthetic-disp-unk-${tag}`, "unk");
    const claims = { userId, workspaceId };
    await setDispatchBudget(pool, claims, { moneyMinor: "20", tokens: 400000, concurrency: 32 });
    const calls = { count: 0 };
    const state = await dispatchModelCall(
      pool,
      claims,
      { idempotencyKey: randomUUID(), permitId: (await issuePermit(pool, claims, "unk-purpose")).id, route: "development", purpose: "unk-purpose", ...RESERVE_OPTS },
      scriptTransport([{ ok: okAttempt(null, null) }], calls),
    );
    expect(state.reservation.status).toBe("PENDING");
    expect(state.usage).toMatchObject({ status: "PENDING", reconciledCostMinor: null, errorClass: "unknown-usage" });
    // The held 16 minor still counts: a second 16-minor dispatch exceeds 20.
    const err = await reserveDispatch(pool, claims, {
      idempotencyKey: randomUUID(),
      permitId: (await issuePermit(pool, claims, "unk-second")).id,
      route: "development",
      purpose: "unk-second",
      ...RESERVE_OPTS,
    }).then(() => null).catch((e: unknown) => (e as DispatchError).code);
    expect(err).toBe("budget_money");
  });

  it("terminal failure releases under the documented class and frees the budget", async () => {
    const base = await startApp();
    const { userId, workspaceId } = await setupWorkspace(base, `synthetic-disp-term-${tag}`, "term");
    const claims = { userId, workspaceId };
    await setDispatchBudget(pool, claims, { moneyMinor: "20", tokens: 400000, concurrency: 32 });
    const calls = { count: 0 };
    const state = await dispatchModelCall(
      pool,
      claims,
      { idempotencyKey: randomUUID(), permitId: (await issuePermit(pool, claims, "term-purpose")).id, route: "development", purpose: "term-purpose", ...RESERVE_OPTS },
      scriptTransport([{ fail: 401 }], calls),
    );
    expect(state.reservation.status).toBe("RELEASED");
    expect(state.usage).toMatchObject({ status: "RELEASED", errorClass: "auth" });
    expect(calls.count).toBe(1);
    // Budget is free again: a full dispatch fits.
    const next = await dispatchModelCall(
      pool,
      claims,
      { idempotencyKey: randomUUID(), permitId: (await issuePermit(pool, claims, "term-next")).id, route: "development", purpose: "term-next", ...RESERVE_OPTS },
      scriptTransport([{ ok: okAttempt(10, 10) }], calls),
    );
    expect(next.reservation.status).toBe("RECONCILED");
  });

  it("revocation after reserve but before dispatch fails closed with no transport call", async () => {
    const base = await startApp();
    const { userId, workspaceId, acctB } = await setupWorkspace(base, `synthetic-disp-rev-${tag}`, "rev");
    const claims = { userId, workspaceId };
    const reserved = await reserveDispatch(pool, claims, {
      idempotencyKey: randomUUID(),
      permitId: (await issuePermit(pool, claims, "rev-purpose")).id,
      route: "development",
      purpose: "rev-purpose",
      ...RESERVE_OPTS,
    });
    expect(reserved.status).toBe("RESERVED");
    await setAccountExclusion(pool, claims, userId, acctB, true, "synthetic revocation");
    const calls = { count: 0 };
    const state = await executeReserved(pool, claims, reserved.id, scriptTransport([{ ok: okAttempt(10, 10) }], calls), RESERVE_OPTS.requestText);
    expect(state.reservation.status).toBe("RELEASED");
    expect(state.usage?.errorClass).toBe("revoked");
    expect(calls.count).toBe(0);
  });

  it("production without qualification fails closed and never consumes the permit", async () => {
    const base = await startApp();
    const { userId, workspaceId } = await setupWorkspace(base, `synthetic-disp-prod-${tag}`, "prod");
    const claims = { userId, workspaceId };
    const saved = process.env["AI_PRODUCTION_QUALIFIED"];
    delete process.env["AI_PRODUCTION_QUALIFIED"];
    try {
      const permit = await issuePermit(pool, claims, "prod-purpose");
      const err = await reserveDispatch(pool, claims, {
        idempotencyKey: randomUUID(),
        permitId: permit.id,
        route: "production",
        purpose: "prod-purpose",
        ...RESERVE_OPTS,
      }).then(() => null).catch((e: unknown) => (e as DispatchError).code);
      expect(err).toBe("route_forbidden");
      // The permit was not consumed: it still authorizes a development call.
      const ok = await reserveDispatch(pool, claims, {
        idempotencyKey: randomUUID(),
        permitId: permit.id,
        route: "development",
        purpose: "prod-purpose",
        ...RESERVE_OPTS,
      });
      expect(ok.status).toBe("RESERVED");
    } finally {
      if (saved === undefined) delete process.env["AI_PRODUCTION_QUALIFIED"];
      else process.env["AI_PRODUCTION_QUALIFIED"] = saved;
    }
  });

  it("one retry only before any provider output; output is never retried", async () => {
    const base = await startApp();
    const { userId, workspaceId } = await setupWorkspace(base, `synthetic-disp-retry-${tag}`, "retry");
    const claims = { userId, workspaceId };
    const retriedCalls = { count: 0 };
    const retried = await dispatchModelCall(
      pool,
      claims,
      { idempotencyKey: randomUUID(), permitId: (await issuePermit(pool, claims, "retry-purpose")).id, route: "development", purpose: "retry-purpose", ...RESERVE_OPTS },
      scriptTransport([{ fail: null }, { ok: okAttempt(50, 25) }], retriedCalls),
    );
    expect(retried.reservation.status).toBe("RECONCILED");
    expect(retried.reservation.attempt).toBe(2);
    expect(retriedCalls.count).toBe(2);
    // Output on the first attempt is terminal for retries: usage unknown
    // stays PENDING after exactly one transport call.
    const outCalls = { count: 0 };
    const out = await dispatchModelCall(
      pool,
      claims,
      { idempotencyKey: randomUUID(), permitId: (await issuePermit(pool, claims, "retry-output")).id, route: "development", purpose: "retry-output", ...RESERVE_OPTS },
      scriptTransport([{ ok: okAttempt(null, 25) }], outCalls),
    );
    expect(out.reservation.status).toBe("PENDING");
    expect(outCalls.count).toBe(1);
    // Exhausted retryable failures stay PENDING (ambiguous), not released.
    const deadCalls = { count: 0 };
    const dead = await dispatchModelCall(
      pool,
      claims,
      { idempotencyKey: randomUUID(), permitId: (await issuePermit(pool, claims, "retry-dead")).id, route: "development", purpose: "retry-dead", ...RESERVE_OPTS },
      scriptTransport([{ fail: 500 }, { fail: 500 }], deadCalls),
    );
    expect(dead.reservation.status).toBe("PENDING");
    expect(dead.reservation.attempt).toBe(2);
    expect(deadCalls.count).toBe(2);
  });

  it("same-key replay converges; same-key different bytes conflicts", async () => {
    const base = await startApp();
    const { userId, workspaceId } = await setupWorkspace(base, `synthetic-disp-idem-${tag}`, "idem");
    const claims = { userId, workspaceId };
    const key = randomUUID();
    const first = await reserveDispatch(pool, claims, {
      idempotencyKey: key,
      permitId: (await issuePermit(pool, claims, "idem-purpose")).id,
      route: "development",
      purpose: "idem-purpose",
      ...RESERVE_OPTS,
    });
    // Genuine replay reuses the reservation without consuming a second permit.
    const replay = await reserveDispatch(pool, claims, {
      idempotencyKey: key,
      permitId: (await issuePermit(pool, claims, "idem-other")).id,
      route: "development",
      purpose: "idem-purpose",
      ...RESERVE_OPTS,
    });
    expect(replay.id).toBe(first.id);
    const clash = await reserveDispatch(pool, claims, {
      idempotencyKey: key,
      permitId: (await issuePermit(pool, claims, "idem-clash")).id,
      route: "development",
      purpose: "idem-purpose",
      ...RESERVE_OPTS,
      requestText: "different bytes",
    }).then(() => null).catch((e: unknown) => (e as DispatchError).code);
    expect(clash).toBe("idempotency_reuse");
  });

  it("same-key concurrent reserves converge on one reservation with typed errors only", async () => {
    const base = await startApp();
    const { userId, workspaceId } = await setupWorkspace(base, `synthetic-disp-samekey-${tag}`, "samekey");
    const claims = { userId, workspaceId };
    await setDispatchBudget(pool, claims, { moneyMinor: "1000000", tokens: 4000000, concurrency: 32 });
    const key = randomUUID();
    const permits = await Promise.all(Array.from({ length: 6 }, (_, i) => issuePermit(pool, claims, `samekey-${i}`)));
    const results = await Promise.all(
      permits.map((permit) =>
        reserveDispatch(pool, claims, { idempotencyKey: key, permitId: permit.id, route: "development", purpose: "samekey", ...RESERVE_OPTS })
          .then((r) => ({ ok: true as const, id: r.id }))
          .catch((err: unknown) => ({ ok: false as const, code: (err as DispatchError).code ?? "untyped" })),
      ),
    );
    const ids = new Set(results.filter((r) => r.ok).map((r) => (r as { id: string }).id));
    expect(ids.size).toBe(1);
    // No raw 23505/500 escapes: every outcome is the typed reservation.
    expect(results.every((r) => r.ok)).toBe(true);
    // Losers never consumed their permits: exactly the winner's permit is
    // spent, the other five still dispatch (deterministic whichever won).
    const after = await Promise.all(
      permits.map((permit) =>
        reserveDispatch(pool, claims, { idempotencyKey: randomUUID(), permitId: permit.id, route: "development", purpose: "samekey", ...RESERVE_OPTS })
          .then(() => "reserved" as const)
          .catch((err: unknown) => (err as DispatchError).code),
      ),
    );
    expect(after.filter((a) => a === "reserved")).toHaveLength(5);
    expect(after.filter((a) => a === "permit_invalid")).toHaveLength(1);
  });

  it("cancel between attempts wins over the retry-revocation settle", async () => {
    const base = await startApp();
    const { userId, workspaceId, acctB } = await setupWorkspace(base, `synthetic-disp-cancelrace-${tag}`, "cancelrace");
    const claims = { userId, workspaceId };
    const reserved = await reserveDispatch(pool, claims, {
      idempotencyKey: randomUUID(),
      permitId: (await issuePermit(pool, claims, "cancelrace-purpose")).id,
      route: "development",
      purpose: "cancelrace-purpose",
      ...RESERVE_OPTS,
    });
    const calls = { count: 0 };
    const transport: DispatchTransport = async () => {
      calls.count += 1;
      // Interleave inside the first attempt: revoke the policy and cancel
      // before the retry-revocation path runs.
      await setAccountExclusion(pool, claims, userId, acctB, true, "synthetic interleave");
      await cancelDispatch(pool, claims, reserved.id);
      return { httpStatus: null, bodyText: null, inputTokens: null, outputTokens: null, model: "double" };
    };
    const state = await executeReserved(pool, claims, reserved.id, transport, RESERVE_OPTS.requestText);
    expect(calls.count).toBe(1);
    expect(state.reservation.status).toBe("CANCELLED");
    expect(state.usage).toMatchObject({ status: "RELEASED", errorClass: "cancelled" });
  });

  it("cancel before dispatch prevents transport; cancel is idempotent and keeps accepted work", async () => {
    const base = await startApp();
    const { userId, workspaceId } = await setupWorkspace(base, `synthetic-disp-cancel-${tag}`, "cancel");
    const claims = { userId, workspaceId };
    const reserved = await reserveDispatch(pool, claims, {
      idempotencyKey: randomUUID(),
      permitId: (await issuePermit(pool, claims, "cancel-purpose")).id,
      route: "development",
      purpose: "cancel-purpose",
      ...RESERVE_OPTS,
    });
    const cancelled = await cancelDispatch(pool, claims, reserved.id);
    expect(cancelled.reservation.status).toBe("CANCELLED");
    expect(cancelled.usage?.status).toBe("RELEASED");
    const calls = { count: 0 };
    const after = await executeReserved(pool, claims, reserved.id, scriptTransport([{ ok: okAttempt(10, 10) }], calls), RESERVE_OPTS.requestText);
    expect(after.reservation.status).toBe("CANCELLED");
    expect(calls.count).toBe(0);
    const again = await cancelDispatch(pool, claims, reserved.id);
    expect(again.reservation.status).toBe("CANCELLED");
  });

  it("oversized requests fail before any permit or budget state changes", async () => {
    const base = await startApp();
    const { userId, workspaceId } = await setupWorkspace(base, `synthetic-disp-big-${tag}`, "big");
    const claims = { userId, workspaceId };
    const permit = await issuePermit(pool, claims, "big-purpose");
    const err = await reserveDispatch(pool, claims, {
      idempotencyKey: randomUUID(),
      permitId: permit.id,
      route: "development",
      purpose: "big-purpose",
      inputEstimate: 10,
      outputCeiling: 10,
      requestText: `x`.repeat(64 * 1024 + 1),
    }).then(() => null).catch((e: unknown) => (e as DispatchError).code);
    expect(err).toBe("request_too_large");
    const ok = await reserveDispatch(pool, claims, {
      idempotencyKey: randomUUID(),
      permitId: permit.id,
      route: "development",
      purpose: "big-purpose",
      inputEstimate: 10,
      outputCeiling: 10,
      requestText: "small",
    });
    expect(ok.status).toBe("RESERVED");
  });

  it("foreign ids are uniformly denied and unscoped reads return no rows", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, `synthetic-disp-tenant-a-${tag}`, "ta");
    const b = await setupWorkspace(base, `synthetic-disp-tenant-b-${tag}`, "tb");
    const claimsA = { userId: a.userId, workspaceId: a.workspaceId };
    const reserved = await reserveDispatch(pool, claimsA, {
      idempotencyKey: randomUUID(),
      permitId: (await issuePermit(pool, claimsA, "tenant-purpose")).id,
      route: "development",
      purpose: "tenant-purpose",
      ...RESERVE_OPTS,
    });
    const denied = await readDispatch(pool, { userId: b.userId, workspaceId: b.workspaceId }, reserved.id).then(() => null).catch((e: unknown) => (e as Error).constructor.name);
    expect(denied).toBe("TenantDenied");
    const missing = await readDispatch(pool, { userId: b.userId, workspaceId: b.workspaceId }, randomUUID()).then(() => null).catch((e: unknown) => (e as Error).constructor.name);
    expect(missing).toBe("TenantDenied");
    const unscoped = await pool.query("SELECT count(*)::int AS n FROM ai_dispatch_reservations");
    expect((unscoped.rows[0] as { n: number }).n).toBe(0);
  });
});
