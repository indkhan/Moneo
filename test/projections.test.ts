// E06-S03 projections and Available to Spend: deterministic daily engine,
// case bps, per-account constraints, ATS matrix. Real PostgreSQL
// (`moneo_e06_projection`, fails closed without PG); synthetic only.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter } from "../apps/web/src/tenancy.ts";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");

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

async function postJson(base: string, path: string, cookie: string, body: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), text };
}

async function getJson(base: string, path: string, cookie: string): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), text };
}

async function setupWorkspace(base: string, sub: string): Promise<{ cookie: string; workspaceId: string }> {
  const cookie = await login(base, sub);
  const ws = (await postJson(base, "/api/workspaces", cookie, { name: "W", baseCurrency: "EUR" })).json as { id: string };
  return { cookie, workspaceId: ws.id };
}

async function createAccount(base: string, cookie: string, workspaceId: string, name: string): Promise<string> {
  const res = await postJson(base, "/api/commands/accounts.create", cookie, {
    workspaceId,
    name,
    currency: "EUR",
    idempotencyKey: randomUUID(),
  });
  expect(res.status).toBe(200);
  return (res.json as { id: string }).id;
}

async function createSnapshot(base: string, cookie: string, workspaceId: string, accountId: string, amountMajor: string): Promise<string> {
  const res = await postJson(base, "/api/commands/accounts.balance_snapshot", cookie, {
    workspaceId,
    accountId,
    asOfDate: "2026-01-01",
    amount: amountMajor,
    currency: "EUR",
    idempotencyKey: randomUUID(),
  });
  expect(res.status).toBe(200);
  return (res.json as { id: string }).id;
}

async function createGoal(base: string, cookie: string, workspaceId: string, name: string): Promise<string> {
  const res = await postJson(base, "/api/commands/goals.create", cookie, {
    workspaceId,
    name,
    goalType: "SAVINGS_TARGET",
    targetAmountMinor: "350000",
    currency: "EUR",
    idempotencyKey: randomUUID(),
  });
  expect(res.status).toBe(200);
  return (res.json as { id: string }).id;
}

async function allocate(base: string, cookie: string, workspaceId: string, goalId: string, accountId: string, amountMajor: string): Promise<{ status: number; json: unknown }> {
  return postJson(base, "/api/commands/allocations.allocate", cookie, {
    workspaceId,
    goalId,
    accountId,
    amountMinor: (BigInt(amountMajor) * 100n).toString(),
    currency: "EUR",
    idempotencyKey: randomUUID(),
  });
}

async function setAssumption(base: string, cookie: string, workspaceId: string, type: string, value: unknown): Promise<{ status: number; json: unknown }> {
  return postJson(base, "/api/commands/assumptions.set", cookie, {
    workspaceId,
    assumptionType: type,
    validFrom: "2026-01-01",
    value,
    idempotencyKey: randomUUID(),
  });
}
async function updateSettings(base: string, cookie: string, workspaceId: string, 
settings: { horizonDays?: number; baselineWeeks?: number; safetyFloorMinor?: string; savingsIncluded?: boolean }): Promise<{ status: number; json: unknown }> {
  return postJson(base, "/api/commands/projection.settings.update", cookie, {
    workspaceId,
    expectedVersion: "1",
    ...settings,
    idempotencyKey: randomUUID(),
  });
}

async function runProjection(base: string, cookie: string, workspaceId: string, horizonDays?: number, spendingAccountId?: string): Promise<{ status: number; json: unknown }> {
  return postJson(base, "/api/projection/run", cookie, {
    workspaceId,
    horizonDays,
    spendingAccountId,
    idempotencyKey: randomUUID(),
  });
}

async function getProjectionRun(base: string, cookie: string, runId: string): Promise<{ status: number; json: unknown }> {
  return getJson(base, `/api/projection/runs/${runId}?workspaceId=${runId.split("-")[0]}`, cookie);
}

beforeAll(async () => {
  pool = await ensureTestPool("E06-S03", "moneo_e06_projection", [
    "projection_runs",
    "projection_points",
    "projection_events",
    "projection_settings",
    "financial_assumptions",
    "goals",
    "goal_allocations",
    "balance_snapshots",
    "balance_audit",
    "accounts",
    "command_operations",
    "audit_events",
    "workspace_data_revision",
    "workspace_members",
    "workspaces",
    "users",
    "app_sessions",
    "recurring_overrides",
    "transactions",
    "manual_transactions",
  ]);
  stub = await startStubIssuer();
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e06-s03 projection engine", () => {
  it("month-end and leap-day schedules produce exact daily balances", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-proj-sched");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");

    // Monthly rent on day 31: Jan 31, Feb 28 (2026 not leap), Mar 31, Apr 30
    await setAssumption(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", {
      amountMinor: "80000",
      currency: "EUR",
      fingerprint: "a".repeat(64),
    });

    // Leap-day annual on Feb 29: 2024-02-29 -> 2025-02-28, 2026-02-28
    await setAssumption(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", {
      amountMinor: "12000",
      currency: "EUR",
      fingerprint: "b".repeat(64),
    });

    const run = await runProjection(base, cookie, workspaceId, 120);
    expect(run.status).toBe(200);
    const runJson = run.json as { runId: string; points: { case_name: string; scope: string; point_date: string; amount_minor: string }[] };
    const points = runJson.points;

    // Find TOTAL scope points for CONSERVATIVE case
    const conservativeTotal = points.filter((p) => p.case_name === "CONSERVATIVE" && p.scope === "TOTAL");
    
    // Jan 31 rent: -80000
    const jan31 = conservativeTotal.find((p) => p.point_date === "2026-01-31");
    expect(jan31).toBeDefined();
    expect(BigInt(jan31!.amount_minor)).toBe(100000n - 80000n); // 1000 - 800 = 200 EUR = 20000

    // Feb 28 (2026 not leap): rent -80000 + leap annual -12000
    const feb28 = conservativeTotal.find((p) => p.point_date === "2026-02-28");
    expect(feb28).toBeDefined();
    expect(BigInt(feb28!.amount_minor)).toBe(20000n - 80000n - 12000n); // 200 - 800 - 120 = -720 EUR = -72000

    // Mar 31 rent
    const mar31 = conservativeTotal.find((p) => p.point_date === "2026-03-31");
    expect(mar31).toBeDefined();
    expect(BigInt(mar31!.amount_minor)).toBe(-72000n - 80000n); // -1520 EUR = -152000
  });

  it("case bps: conservative income 90%, expense 110%; optimistic 110%, 90%", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-proj-bps");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");

    // Monthly income €1000 on 1st, monthly expense €500 on 15th
    await setAssumption(base, cookie, workspaceId, "EXPECTED_INCOME", {
      amountMinor: "100000",
      currency: "EUR",
      cadence: "MONTHLY",
      dayOfMonth: 1,
    });
    await setAssumption(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", {
      amountMinor: "50000",
      currency: "EUR",
      fingerprint: "c".repeat(64),
    });

    const run = await runProjection(base, cookie, workspaceId, 60);
    expect(run.status).toBe(200);
    const runJson = run.json as { points: { case_name: string; scope: string; point_date: string; amount_minor: string }[] };
    const points = runJson.points;

    // Day 1: income +100000 (expected) -> conservative +90000, optimistic +110000
    const day1Expected = points.find((p) => p.case_name === "EXPECTED" && p.scope === "TOTAL" && p.point_date === "2026-01-01");
    const day1Conservative = points.find((p) => p.case_name === "CONSERVATIVE" && p.scope === "TOTAL" && p.point_date === "2026-01-01");
    const day1Optimistic = points.find((p) => p.case_name === "OPTIMISTIC" && p.scope === "TOTAL" && p.point_date === "2026-01-01");
    expect(BigInt(day1Expected!.amount_minor)).toBe(100000n + 100000n); // 1000 + 1000 = 2000
    expect(BigInt(day1Conservative!.amount_minor)).toBe(90000n + 100000n); // 900 + 1000 = 1900
    expect(BigInt(day1Optimistic!.amount_minor)).toBe(110000n + 100000n); // 1100 + 1000 = 2100

    // Day 15: expense -50000 -> conservative -55000, optimistic -45000
    const day15Expected = points.find((p) => p.case_name === "EXPECTED" && p.scope === "TOTAL" && p.point_date === "2026-01-15");
    const day15Conservative = points.find((p) => p.case_name === "CONSERVATIVE" && p.scope === "TOTAL" && p.point_date === "2026-01-15");
    const day15Optimistic = points.find((p) => p.case_name === "OPTIMISTIC" && p.scope === "TOTAL" && p.point_date === "2026-01-15");
    const before15 = BigInt(points.find((p) => p.case_name === "EXPECTED" && p.scope === "TOTAL" && p.point_date === "2026-01-14")!.amount_minor);
    expect(BigInt(day15Expected!.amount_minor)).toBe(before15 - 50000n);
    expect(BigInt(day15Conservative!.amount_minor)).toBe(before15 - 55000n);
    expect(BigInt(day15Optimistic!.amount_minor)).toBe(before15 - 45000n);
  });
});

describe("e06-s03 Available to Spend", () => {
  it("AVAILABLE with positive headroom, naming limiting day/account", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-ats-available");
    const accountId = await createAccount(base, cookie, workspaceId, "Checking");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");
    await updateSettings(base, cookie, workspaceId, { horizonDays: 30 });

    const run = await runProjection(base, cookie, workspaceId, 30, accountId);
    expect(run.status).toBe(200);
    const runJson = run.json as { ats: { status: string; amountMinor: string; limitingDay: string; limitingAccount: string } };
    expect(runJson.ats.status).toBe("AVAILABLE");
    expect(BigInt(runJson.ats.amountMinor)).toBeGreaterThan(0n);
    expect(runJson.ats.limitingDay).toBeDefined();
    expect(runJson.ats.limitingAccount).toBeDefined();
  });

  it("SHORTFALL shows zero + shortfallMinor + date when headroom negative", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-ats-shortfall");
    const accountId = await createAccount(base, cookie, workspaceId, "Checking");
    await createSnapshot(base, cookie, workspaceId, accountId, "100.00");
    // Large recurring expense that exhausts balance
    await setAssumption(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", {
      amountMinor: "20000",
      currency: "EUR",
      fingerprint: "d".repeat(64),
    });
    await updateSettings(base, cookie, workspaceId, { horizonDays: 10 });

    const run = await runProjection(base, cookie, workspaceId, 10, accountId);
    expect(run.status).toBe(200);
    const runJson = run.json as { ats: { status: string; amountMinor: string; shortfallMinor: string; shortfallDate: string } };
    expect(runJson.ats.status).toBe("SHORTFALL");
    expect(runJson.ats.amountMinor).toBe("0");
    expect(BigInt(runJson.ats.shortfallMinor)).toBeGreaterThan(0n);
    expect(runJson.ats.shortfallDate).toBeDefined();
  });

  it("UNAVAILABLE when required balance snapshot missing", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-ats-unavail");
    const accountId = await createAccount(base, cookie, workspaceId, "Checking");
    // No balance snapshot created
    await updateSettings(base, cookie, workspaceId, { horizonDays: 30 });

    const run = await runProjection(base, cookie, workspaceId, 30, accountId);
    expect(run.status).toBe(200);
    const runJson = run.json as { ats: { status: string; reasons: string[] } };
    expect(runJson.ats.status).toBe("UNAVAILABLE");
    expect(runJson.ats.reasons).toContain("missing_balance");
  });

  it("funding-gap warning when no spending account selected and per-account constraints fail", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-ats-gap");
    const checkingId = await createAccount(base, cookie, workspaceId, "Checking");
    const savingsId = await createAccount(base, cookie, workspaceId, "Savings");
    await createSnapshot(base, cookie, workspaceId, checkingId, "100.00");
    await createSnapshot(base, cookie, workspaceId, savingsId, "5000.00");
    // Large expense on checking that exceeds its balance
    await setAssumption(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", {
      amountMinor: "20000",
      currency: "EUR",
      fingerprint: "e".repeat(64),
    });
    await updateSettings(base, cookie, workspaceId, { horizonDays: 30, savingsIncluded: true });

    // No spendingAccountId provided -> aggregate headroom only when all constraints hold
    const run = await runProjection(base, cookie, workspaceId, 30);
    expect(run.status).toBe(200);
    const runJson = run.json as { ats: { status: string; reasons: string[] } };
    expect(runJson.ats.status).toBe("UNAVAILABLE");
    expect(runJson.ats.reasons).toContain("funding_gap");
  });
});