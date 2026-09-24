// E06-S04 forecast tools: forecast.evaluate and forecast.compareScenarios are
// thin adapters over the shared projection engine — same ATS/points bytes,
// exclusions deny before aggregation, unknown scenarios deny, malformed args
// fail typed, stale contexts block, unknown tools stay unknown.
// Real PostgreSQL (own `moneo_e06_forecast_tools` DB, fails closed);
// synthetic data only, no secrets.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { setAccountExclusion } from "../apps/web/src/ai-policy.ts";
import { bumpWorkspaceRevision } from "../apps/web/src/calculations/evidence.ts";
import { createToolContext, executeTool, MAX_TOOL_ACCOUNTS, ToolError, type ToolContext } from "../apps/web/src/ai-tools.ts";
import { evaluateProjection } from "../apps/web/src/projections/engine.ts";
import { compareScenarios } from "../apps/web/src/projections/scenarios.ts";
import { claimChatGeneration, createThread, sendTurn } from "../apps/web/src/chat.ts";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
let base = "";
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
const tag = randomBytes(4).toString("hex");

type Fx = { cookie: string; userId: string; workspaceId: string; acct: string };
type EvalResult = {
  horizonStart: string; horizonDays: number; baseCurrency: string; inputHash: string;
  ats: unknown; truncated: boolean; coverage: Record<string, unknown>;
  points: { caseName: string; scope: string; pointDate: string; amountMinor: string; currencyCode: string }[];
};
type CmpResult = {
  baselineInputHash: string; scenarioInputHash: string; baselineAts: unknown; scenarioAts: unknown;
  deltas: { caseName: string; scope: string; pointDate: string; baselineMinor: string; scenarioMinor: string; deltaMinor: string; currency: string }[];
};

async function login(loginAs: string): Promise<string> {
  const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const authorizeUrl = `${start.headers.get("location")!}&login_as=${loginAs}`;
  const callbackUrl = (await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!;
  const done = await fetch(callbackUrl, { redirect: "manual" });
  return done.headers.get("set-cookie")!.split(";")[0];
}

async function postJson(path: string, cookie: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: JSON.parse(await res.text()) };
}

/** Each test gets its own workspace: policy/exclusion state never leaks across tests. */
async function setupFx(sub: string, snapshotMajor = "1000.00"): Promise<Fx> {
  const cookie = await login(`synthetic-fc-${tag}-${sub}`);
  const ws = (await postJson("/api/workspaces", cookie, { name: `W-${sub}`, baseCurrency: "EUR" })).json as { id: string };
  const workspaceId = ws.id;
  const acct = ((await postJson("/api/commands/accounts.create", cookie, { workspaceId, name: `FC-${sub}`, currency: "EUR", idempotencyKey: randomUUID() })).json as { id: string }).id;
  const snap = await postJson("/api/commands/accounts.balance_snapshot", cookie, { workspaceId, accountId: acct, asOfDate: "2026-01-01", amount: snapshotMajor, currency: "EUR", idempotencyKey: randomUUID() });
  expect(snap.status).toBe(200);
  const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [`synthetic-fc-${tag}-${sub}`])).rows[0] as { id: string }).id;
  return { cookie, userId, workspaceId, acct };
}

async function setMonthlyIncome(fx: Fx, amountMinor: string): Promise<void> {
  const res = await postJson("/api/commands/assumptions.set", fx.cookie, {
    workspaceId: fx.workspaceId, assumptionType: "EXPECTED_INCOME", validFrom: "2026-01-01",
    value: { amountMinor, currency: "EUR", cadence: "MONTHLY", dayOfMonth: 1 }, idempotencyKey: randomUUID(),
  });
  expect(res.status).toBe(200);
}

async function makeScenario(fx: Fx, name: string): Promise<string> {
  const res = await postJson("/api/commands/scenarios.create", fx.cookie, { workspaceId: fx.workspaceId, name, idempotencyKey: randomUUID() });
  expect(res.status).toBe(200);
  return (res.json as { id: string }).id;
}

/** A real claimed attempt: tool records FK to chat_attempts, like the worker path. */
async function newAttempt(fx: Fx, suffix: string): Promise<string> {
  const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
  const thread = await createThread(pool, claims, fx.userId, { title: suffix });
  const sent = await sendTurn(pool, claims, fx.userId, { threadId: thread.id, body: `probe ${suffix}`, idempotencyKey: randomUUID() });
  const claimed = await claimChatGeneration(pool, sent.jobId, { workerId: "forecast-tools-test", leaseMs: 30_000 });
  if (!claimed) throw new Error("probe claim failed");
  return claimed.attemptId;
}

async function codeOf(ctx: ToolContext, attempt: string, step: number, name: string, args: unknown): Promise<string> {
  try {
    await executeTool(pool, ctx, attempt, step, { name, args });
    return "ok";
  } catch (e) {
    return (e as ToolError).code ?? "untyped";
  }
}

beforeAll(async () => {
  process.env["APP_ENV"] = "test";
  pool = await ensureTestPool("E06-S04", "moneo_e06_forecast_tools", ["chat_tool_calls", "chat_activity", "chat_attempts", "chat_turns", "chat_threads", "ai_dispatch_usage", "ai_dispatch_reservations", "ai_dispatch_budgets", "ai_dispatch_permits", "ai_exclusions", "ai_policies", "scenario_overrides", "scenarios", "projection_runs", "projection_points", "projection_events", "projection_settings", "financial_assumptions", "goals", "goal_allocations", "recurring_overrides", "source_links", "transactions", "manual_transactions", "balance_snapshots", "balance_audit", "audit_events", "workspace_data_revision", "command_operations", "accounts", "imports", "workspace_members", "workspaces", "users", "app_sessions"]);
  stub = await startStubIssuer();
  const config: AuthConfig = { issuer: stub.base, clientId: STUB_CLIENT_ID, clientSecret: STUB_CLIENT_SECRET, appBaseUrl: "http://127.0.0.1:1", sessionSecret, sessionTtlSec: 43200 };
  const server = createApp(createAuthRouter(config, pool), createTenancyRouter(pool, (req) => requestSession(pool, sessionSecret, req)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  appServers.push(server);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.appBaseUrl = base;
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (pool) await pool.end();
});

describe("e06-s04 forecast tools", () => {
  it("evaluate matches the shared engine with hand-computed daily balances", async () => {
    expect(MAX_TOOL_ACCOUNTS).toBe(10);
    const fx = await setupFx("eval");
    await setMonthlyIncome(fx, "100000");
    expect((await postJson("/api/commands/assumptions.set", fx.cookie, {
      workspaceId: fx.workspaceId, assumptionType: "EXPECTED_VARIABLE_SPEND", validFrom: "2026-01-01",
      value: { amountMinor: "0", currency: "EUR" }, idempotencyKey: randomUUID(),
    })).status).toBe(200);
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const ctx = await createToolContext(pool, claims);
    const out = (await executeTool(pool, ctx, await newAttempt(fx, "eval"), 1, { name: "forecast.evaluate", args: { horizonDays: 3 } })).result as EvalResult;
    const engine = await evaluateProjection(pool, claims, { horizonDays: 3 });
    // Adapter parity: identical ATS, points and input hash.
    expect(out.ats).toEqual(engine.ats);
    expect(JSON.stringify(out.ats)).toBe(JSON.stringify(engine.ats));
    expect(out.inputHash).toBe(engine.inputHash);
    expect(out.points).toEqual(engine.points.map((p) => ({ caseName: p.caseName, scope: p.scope, pointDate: p.pointDate, amountMinor: p.amountMinor, currencyCode: p.currencyCode })));
    // Hand oracle: snapshot 100000 + monthly income 100000 on day 1, floor 0.
    // EXPECTED 200000/day, CONSERVATIVE 90000 income -> 190000, OPTIMISTIC 210000.
    expect(out.horizonStart).toBe("2026-01-01");
    const at = (c: string, scope: string, date: string) => out.points.find((p) => p.caseName === c && p.scope === scope && p.pointDate === date)!.amountMinor;
    expect(at("EXPECTED", fx.acct, "2026-01-01")).toBe("200000");
    expect(at("EXPECTED", fx.acct, "2026-01-02")).toBe("200000");
    expect(at("CONSERVATIVE", fx.acct, "2026-01-01")).toBe("190000");
    expect(at("OPTIMISTIC", fx.acct, "2026-01-01")).toBe("210000");
    expect(at("EXPECTED", "TOTAL", "2026-01-01")).toBe("200000");
    expect(out.ats).toMatchObject({ status: "AVAILABLE", amountMinor: "190000" });
  });

  it("excluded spending account denies without a total", async () => {
    const fx = await setupFx("excl");
    await setMonthlyIncome(fx, "100000");
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    await setAccountExclusion(pool, claims, fx.userId, fx.acct, true, "synthetic");
    const ctx = await createToolContext(pool, claims);
    expect(ctx.eligibleAccountIds).not.toContain(fx.acct);
    const code = await codeOf(ctx, await newAttempt(fx, "excl"), 1, "forecast.evaluate", { horizonDays: 3, spendingAccountId: fx.acct });
    expect(code).toBe("denied");
  });

  it("unhinted evaluate with an excluded account never returns full totals", async () => {
    const fx = await setupFx("excl-all");
    await setMonthlyIncome(fx, "100000");
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    await setAccountExclusion(pool, claims, fx.userId, fx.acct, true, "synthetic");
    const ctx = await createToolContext(pool, claims);
    expect(ctx.eligibleAccountIds).not.toContain(fx.acct);
    // No spendingAccountId hint: the engine aggregates the eligible set only.
    // The sole account is excluded, so no spendable accounts remain — the
    // result is UNAVAILABLE (no_spendable_accounts), never a full total.
    const out = (await executeTool(pool, ctx, await newAttempt(fx, "excl-all"), 1, { name: "forecast.evaluate", args: { horizonDays: 3 } })).result as EvalResult;
    const ats = out.ats as { status: string };
    expect(ats.status).toBe("UNAVAILABLE");
    expect((out.coverage as { aiCoverage?: string }).aiCoverage).toContain("partial");
    expect(out.points.filter((p) => p.scope === fx.acct)).toHaveLength(0);
  });

  it("unknown/foreign scenarios deny; malformed args are invalid", async () => {
    const fx = await setupFx("args");
    await setMonthlyIncome(fx, "100000");
    const other = await setupFx("args-foreign");
    const foreignScenario = await makeScenario(other, "Foreign");
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const ctx = await createToolContext(pool, claims);
    const attempt = await newAttempt(fx, "args");
    const codes = [
      await codeOf(ctx, attempt, 1, "forecast.evaluate", { scenarioId: randomUUID() }),
      await codeOf(ctx, attempt, 2, "forecast.evaluate", { scenarioId: foreignScenario }),
      await codeOf(ctx, attempt, 3, "forecast.compareScenarios", { scenarioId: foreignScenario, horizonDays: 10 }),
      await codeOf(ctx, attempt, 4, "forecast.evaluate", { spendingAccountId: "not-a-uuid" }),
      await codeOf(ctx, attempt, 5, "forecast.evaluate", { scenarioId: "not-a-uuid" }),
      await codeOf(ctx, attempt, 6, "forecast.evaluate", { horizonDays: 0 }),
      await codeOf(ctx, attempt, 7, "forecast.evaluate", { horizonDays: 500 }),
      await codeOf(ctx, attempt, 8, "forecast.evaluate", { horizonDays: 10, bogus: 1 }),
      await codeOf(ctx, attempt, 9, "forecast.compareScenarios", { horizonDays: 10 }),
      await codeOf(ctx, attempt, 10, "forecast.compareScenarios", { scenarioId: "not-a-uuid" }),
    ];
    expect(codes).toEqual(["denied", "denied", "denied", "invalid_args", "invalid_args", "invalid_args", "invalid_args", "invalid_args", "invalid_args", "invalid_args"]);
  });

  it("compareScenarios matches the engine with exact one-time deltas", async () => {
    const fx = await setupFx("cmp", "2000.00");
    const scenarioId = await makeScenario(fx, "Japan trip");
    const added = await postJson("/api/commands/scenario-overrides.add", fx.cookie, {
      workspaceId: fx.workspaceId, scenarioId, overrideType: "ONE_TIME_EXPENSE",
      payload: { amountMinor: "90000", currency: "EUR", date: "2026-03-10", accountId: fx.acct, description: "Japan flight" }, idempotencyKey: randomUUID(),
    });
    expect(added.status).toBe(200);
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const ctx = await createToolContext(pool, claims);
    const out = (await executeTool(pool, ctx, await newAttempt(fx, "cmp"), 1, { name: "forecast.compareScenarios", args: { scenarioId, horizonDays: 120 } })).result as CmpResult;
    const engine = await compareScenarios(pool, claims, { workspaceId: fx.workspaceId, scenarioId, horizonDays: 120 });
    // Byte-identical ATS and hashes, exact engine deltas.
    expect(JSON.stringify(out.baselineAts)).toBe(JSON.stringify(engine.baselineAts));
    expect(JSON.stringify(out.scenarioAts)).toBe(JSON.stringify(engine.scenarioAts));
    expect(out.baselineInputHash).toBe(engine.baselineInputHash);
    expect(out.scenarioInputHash).toBe(engine.scenarioInputHash);
    expect(out.deltas).toEqual(engine.deltas.map((d) => ({ caseName: d.caseName, scope: d.scope, pointDate: d.pointDate, baselineMinor: d.baselineMinor, scenarioMinor: d.scenarioMinor, deltaMinor: d.deltaMinor, currency: d.currency })));
    // Hand oracle: no delta before the flight; exactly -90000 from 2026-03-10 on.
    expect(out.deltas.filter((d) => d.pointDate < "2026-03-10")).toHaveLength(0);
    const flight = out.deltas.filter((d) => d.caseName === "EXPECTED" && d.scope === fx.acct && d.pointDate === "2026-03-10");
    expect(flight).toHaveLength(1);
    expect(flight[0]!.deltaMinor).toBe("-90000");
    expect(flight[0]!.scenarioMinor).toBe((BigInt(flight[0]!.baselineMinor) - 90000n).toString());
    const later = out.deltas.find((d) => d.caseName === "EXPECTED" && d.scope === fx.acct && d.pointDate === "2026-03-11");
    expect(later?.deltaMinor).toBe("-90000");
  });

  it("revision drift between context and dispatch blocks stale", async () => {
    const fx = await setupFx("stale");
    await setMonthlyIncome(fx, "100000");
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const ctx = await createToolContext(pool, claims);
    await bumpWorkspaceRevision(pool, claims, fx.userId, { workspaceId: fx.workspaceId, idempotencyKey: randomUUID() });
    // Same stale pattern as the E04-S03 revision test: no execution, typed error.
    const code = await codeOf(ctx, await newAttempt(fx, "stale"), 1, "forecast.evaluate", { horizonDays: 3 });
    expect(code).toBe("stale");
  });

  it("unknown tool names stay unknown with the extended allowlist", async () => {
    const fx = await setupFx("unknown");
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const ctx = await createToolContext(pool, claims);
    const attempt = await newAttempt(fx, "unknown");
    expect(await codeOf(ctx, attempt, 1, "forecast.guess", {})).toBe("unknown_tool");
    expect(await codeOf(ctx, attempt, 2, "sql.query", { sql: "SELECT 1" })).toBe("unknown_tool");
  });
});
