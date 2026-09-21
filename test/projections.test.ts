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
  const current = (await getJson(base, `/api/projection/settings?workspaceId=${workspaceId}`, cookie)).json as { version: string };
  return postJson(base, "/api/commands/projection.settings.update", cookie, {
    workspaceId,
    expectedVersion: current.version,
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

    // Monthly rent on day 31: Jan 31, Feb 28 (2026 not leap), Mar 31.
    // Case bps apply uniformly to assumption amounts (S03 contract).
    const rent = await setAssumption(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", {
      amountMinor: "80000",
      currency: "EUR",
      cadence: "MONTHLY",
      dayOfMonth: 31,
      direction: "OUTFLOW",
      fingerprint: "a".repeat(64),
    });
    expect(rent.status).toBe(200);

    // Yearly Feb-29 annual: 2026-02-28 in a non-leap year.
    const annual = await setAssumption(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", {
      amountMinor: "12000",
      currency: "EUR",
      cadence: "YEARLY",
      month: 2,
      dayOfMonth: 29,
      direction: "OUTFLOW",
      fingerprint: "b".repeat(64),
    });
    expect(annual.status).toBe(200);

    const run = await runProjection(base, cookie, workspaceId, 120);
    expect(run.status).toBe(200);
    const runJson = run.json as { runId: string; points: { case_name: string; scope: string; point_date: string; amount_minor: string }[] };
    const points = runJson.points;
    expect(runJson.runId).toBeDefined();

    // EXPECTED is unscaled; CONSERVATIVE scales expenses x1.1.
    const expectedTotal = points.filter((p) => p.case_name === "EXPECTED" && p.scope === "TOTAL");
    const conservativeTotal = points.filter((p) => p.case_name === "CONSERVATIVE" && p.scope === "TOTAL");

    const jan31exp = expectedTotal.find((p) => p.point_date === "2026-01-31");
    expect(jan31exp).toBeDefined();
    expect(BigInt(jan31exp!.amount_minor)).toBe(100000n - 80000n);
    const jan31 = conservativeTotal.find((p) => p.point_date === "2026-01-31");
    expect(jan31).toBeDefined();
    expect(BigInt(jan31!.amount_minor)).toBe(100000n - 88000n);

    const feb28 = conservativeTotal.find((p) => p.point_date === "2026-02-28");
    expect(feb28).toBeDefined();
    expect(BigInt(feb28!.amount_minor)).toBe(12000n - 88000n - 13200n);

    const mar31 = conservativeTotal.find((p) => p.point_date === "2026-03-31");
    expect(mar31).toBeDefined();
    expect(BigInt(mar31!.amount_minor)).toBe(-89200n - 88000n);

    // TOTAL equals the single account scope exactly.
    const acctJan31 = points.find((p) => p.case_name === "CONSERVATIVE" && p.scope === accountId && p.point_date === "2026-01-31");
    expect(acctJan31).toBeDefined();
    expect(BigInt(acctJan31!.amount_minor)).toBe(BigInt(jan31!.amount_minor));
  });

  it("case bps: conservative income 90%, expense 110%; optimistic 110%, 90%", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-proj-bps");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");

    // Monthly income EUR 1000 on the 1st, monthly expense EUR 500 on the 15th.
    const income = await setAssumption(base, cookie, workspaceId, "EXPECTED_INCOME", {
      amountMinor: "100000",
      currency: "EUR",
      cadence: "MONTHLY",
      dayOfMonth: 1,
    });
    expect(income.status).toBe(200);
    const expense = await setAssumption(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", {
      amountMinor: "50000",
      currency: "EUR",
      cadence: "MONTHLY",
      dayOfMonth: 15,
      direction: "OUTFLOW",
      fingerprint: "c".repeat(64),
    });
    expect(expense.status).toBe(200);

    const run = await runProjection(base, cookie, workspaceId, 60);
    expect(run.status).toBe(200);
    const runJson = run.json as { points: { case_name: string; scope: string; point_date: string; amount_minor: string }[] };
    const points = runJson.points;

    // Day 1: income +100000 (expected) -> conservative +90000, optimistic +110000
    const day1Expected = points.find((p) => p.case_name === "EXPECTED" && p.scope === "TOTAL" && p.point_date === "2026-01-01");
    const day1Conservative = points.find((p) => p.case_name === "CONSERVATIVE" && p.scope === "TOTAL" && p.point_date === "2026-01-01");
    const day1Optimistic = points.find((p) => p.case_name === "OPTIMISTIC" && p.scope === "TOTAL" && p.point_date === "2026-01-01");
    expect(day1Expected).toBeDefined();
    expect(day1Conservative).toBeDefined();
    expect(day1Optimistic).toBeDefined();
    expect(BigInt(day1Expected!.amount_minor)).toBe(100000n + 100000n); // 1000 + 1000 = 2000
    expect(BigInt(day1Conservative!.amount_minor)).toBe(100000n + 90000n); // 900 + 1000 = 1900
    expect(BigInt(day1Optimistic!.amount_minor)).toBe(100000n + 110000n); // 1100 + 1000 = 2100

    // Day 15: expense -50000 -> conservative -55000, optimistic -45000
    const day15Expected = points.find((p) => p.case_name === "EXPECTED" && p.scope === "TOTAL" && p.point_date === "2026-01-15");
    const day15Conservative = points.find((p) => p.case_name === "CONSERVATIVE" && p.scope === "TOTAL" && p.point_date === "2026-01-15");
    const day15Optimistic = points.find((p) => p.case_name === "OPTIMISTIC" && p.scope === "TOTAL" && p.point_date === "2026-01-15");
    expect(day15Expected).toBeDefined();
    expect(day15Conservative).toBeDefined();
    expect(day15Optimistic).toBeDefined();
    const before15 = BigInt(points.find((p) => p.case_name === "EXPECTED" && p.scope === "TOTAL" && p.point_date === "2026-01-14")!.amount_minor);
    const before15cons = BigInt(points.find((p) => p.case_name === "CONSERVATIVE" && p.scope === "TOTAL" && p.point_date === "2026-01-14")!.amount_minor);
    const before15opt = BigInt(points.find((p) => p.case_name === "OPTIMISTIC" && p.scope === "TOTAL" && p.point_date === "2026-01-14")!.amount_minor);
    expect(BigInt(day15Expected!.amount_minor)).toBe(before15 - 50000n);
    expect(BigInt(day15Conservative!.amount_minor)).toBe(before15cons - 55000n);
    expect(BigInt(day15Optimistic!.amount_minor)).toBe(before15opt - 45000n);
  });

  it("explicitly scheduled inter-account transfer moves scopes but not TOTAL", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-proj-transfer");
    const checkingId = await createAccount(base, cookie, workspaceId, "Checking");
    const savingsId = await createAccount(base, cookie, workspaceId, "Savings");
    await createSnapshot(base, cookie, workspaceId, checkingId, "1000.00");
    await createSnapshot(base, cookie, workspaceId, savingsId, "500.00");

    const transfer = await setAssumption(base, cookie, workspaceId, "ONE_TIME_EXPECTED_EXPENSE", {
      amountMinor: "20000",
      currency: "EUR",
      direction: "OUTFLOW",
      date: "2026-01-10",
      accountId: checkingId,
      toAccountId: savingsId,
      description: "monthly savings move",
    });
    expect(transfer.status).toBe(200);

    const run = await runProjection(base, cookie, workspaceId, 30);
    expect(run.status).toBe(200);
    const runJson = run.json as { points: { case_name: string; scope: string; point_date: string; amount_minor: string }[] };
    const at = (scope: string, date: string) =>
      BigInt(runJson.points.find((p) => p.case_name === "EXPECTED" && p.scope === scope && p.point_date === date)!.amount_minor);
    expect(at(checkingId, "2026-01-10")).toBe(100000n - 20000n);
    expect(at(savingsId, "2026-01-10")).toBe(50000n + 20000n);
    expect(at("TOTAL", "2026-01-10")).toBe(150000n);
    // Transfers are case-neutral: all three cases agree exactly.
    for (const c of ["CONSERVATIVE", "OPTIMISTIC"]) {
      const atc = (scope: string, date: string) =>
        BigInt(runJson.points.find((p) => p.case_name === c && p.scope === scope && p.point_date === date)!.amount_minor);
      expect(atc(checkingId, "2026-01-10")).toBe(80000n);
      expect(atc(savingsId, "2026-01-10")).toBe(70000n);
      expect(atc("TOTAL", "2026-01-10")).toBe(150000n);
    }
  });

  it("snapshot-before-start with a booking on the start day counts exactly once", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-proj-boundary");
    const accountA = await createAccount(base, cookie, workspaceId, "A");
    const accountB = await createAccount(base, cookie, workspaceId, "B");
    await createSnapshot(base, cookie, workspaceId, accountA, "1000.00");
    // B's later snapshot anchors the horizon start at 2026-01-10.
    const snapB = await postJson(base, "/api/commands/accounts.balance_snapshot", cookie, {
      workspaceId,
      accountId: accountB,
      asOfDate: "2026-01-10",
      amount: "500.00",
      currency: "EUR",
      idempotencyKey: randomUUID(),
    });
    expect(snapB.status).toBe(200);
    // Booking on A dated exactly the start day: forward-reconcile must skip it
    // (strict <) while the day-0 replay includes it (>=) — counted once.
    const booked = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId: accountA,
      amount: "200.00",
      currency: "EUR",
      direction: "INFLOW",
      effectiveDate: "2026-01-10",
      description: "Boundary pay",
      idempotencyKey: randomUUID(),
    });
    expect(booked.status).toBe(200);

    const run = await runProjection(base, cookie, workspaceId, 30);
    expect(run.status).toBe(200);
    const runJson = run.json as { points: { case_name: string; scope: string; point_date: string; amount_minor: string }[] };
    const at = (scope: string, date: string) =>
      BigInt(runJson.points.find((p) => p.case_name === "EXPECTED" && p.scope === scope && p.point_date === date)!.amount_minor);
    expect(at(accountA, "2026-01-10")).toBe(120000n);
    expect(at(accountB, "2026-01-10")).toBe(50000n);
    expect(at("TOTAL", "2026-01-10")).toBe(170000n);
  });

  it("identical inputs return the same run id with byte-identical points", async () => {    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-proj-idem");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");

    const first = (await runProjection(base, cookie, workspaceId, 30)).json as { runId: string; points: unknown[] };
    const second = (await runProjection(base, cookie, workspaceId, 30)).json as { runId: string; points: unknown[] };
    expect(second.runId).toBe(first.runId);
    expect(JSON.stringify(second.points)).toBe(JSON.stringify(first.points));
  });
});

describe("e06-s03 projection wording", () => {
  it("never uses probability or safety-guarantee wording in code or responses", async () => {
    const { readFileSync } = await import("node:fs");
    // Word boundaries: safetyFloorMinor / confidence must NOT match.
    const banned = [/\bguarantee[sd]?\b/i, /\bprobabilit\w*\b/i, /\bP10\b/, /\bP50\b/, /\bP90\b/, /\b90%\s*safe\b/i, /\bsafe\b/i, /\bcalibrat\w*\b/i];
    for (const file of ["apps/web/src/projections/engine.ts", "apps/web/src/projections/inputs.ts", "apps/web/src/projections/schedule.ts", "apps/web/src/projections/baseline.ts"]) {
      const text = readFileSync(file, "utf8");
      for (const re of banned) {
        const at = text.search(re);
        expect(at, `${file} contains banned wording ${re}`).toBe(-1);
      }
    }
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
    // Monthly EUR 200 expense on the 5th exhausts the EUR 100 balance.
    const expense = await setAssumption(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", {
      amountMinor: "20000",
      currency: "EUR",
      cadence: "MONTHLY",
      dayOfMonth: 5,
      direction: "OUTFLOW",
      accountId,
      fingerprint: "d".repeat(64),
    });
    expect(expense.status).toBe(200);
    const settings = await updateSettings(base, cookie, workspaceId, { horizonDays: 10 });
    expect(settings.status).toBe(200);

    const run = await runProjection(base, cookie, workspaceId, 10, accountId);
    expect(run.status).toBe(200);
    const runJson = run.json as { ats: { status: string; amountMinor: string; shortfallMinor: string; shortfallDate: string } };
    expect(runJson.ats.status).toBe("SHORTFALL");
    expect(runJson.ats.amountMinor).toBe("0");
    expect(BigInt(runJson.ats.shortfallMinor)).toBe(12000n);
    expect(runJson.ats.shortfallDate).toBe("2026-01-05");
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
    // Monthly EUR 200 expense on the 5th of the checking account exhausts it
    // while the workspace total stays positive: a funding gap, not fungible cash.
    const expense = await setAssumption(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", {
      amountMinor: "20000",
      currency: "EUR",
      cadence: "MONTHLY",
      dayOfMonth: 5,
      direction: "OUTFLOW",
      accountId: checkingId,
      fingerprint: "e".repeat(64),
    });
    expect(expense.status).toBe(200);
    const gapSettings = await updateSettings(base, cookie, workspaceId, { horizonDays: 30, savingsIncluded: true });
    expect(gapSettings.status).toBe(200);

    // No spendingAccountId provided -> aggregate headroom only when all constraints hold
    const run = await runProjection(base, cookie, workspaceId, 30);
    expect(run.status).toBe(200);
    const runJson = run.json as { ats: { status: string; reasons: string[] } };
    expect(runJson.ats.status).toBe("UNAVAILABLE");
    expect(runJson.ats.reasons).toContain("funding_gap");
  });

  it("UNAVAILABLE with missing_fx when a contributing currency has no rate", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-ats-fx");
    // KWD account: exact-money supported (exp 3) but absent from ECB reference rates.
    const kwd = await postJson(base, "/api/commands/accounts.create", cookie, {
      workspaceId,
      name: "KWD Cash",
      currency: "KWD",
      idempotencyKey: randomUUID(),
    });
    expect(kwd.status).toBe(200);
    const kwdId = (kwd.json as { id: string }).id;
    const snap = await postJson(base, "/api/commands/accounts.balance_snapshot", cookie, {
      workspaceId,
      accountId: kwdId,
      asOfDate: "2026-01-01",
      amount: "100.000",
      currency: "KWD",
      idempotencyKey: randomUUID(),
    });
    expect(snap.status).toBe(200);
    await updateSettings(base, cookie, workspaceId, { horizonDays: 30 });

    const run = await runProjection(base, cookie, workspaceId, 30, kwdId);
    expect(run.status).toBe(200);
    const runJson = run.json as { ats: { status: string; reasons: string[] } };
    expect(runJson.ats.status).toBe("UNAVAILABLE");
    expect(runJson.ats.reasons).toContain("missing_fx");
  });

  it("UNAVAILABLE with missing_commitments for unlinkable fingerprint assumptions", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-ats-commit");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");
    // Fingerprint-only with no confirmed recurring override: unschedulable.
    const linked = await setAssumption(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", {
      amountMinor: "50000",
      currency: "EUR",
      fingerprint: "f".repeat(64),
    });
    expect(linked.status).toBe(200);

    const run = await runProjection(base, cookie, workspaceId, 30, accountId);
    expect(run.status).toBe(200);
    const runJson = run.json as { ats: { status: string; reasons: string[] } };
    expect(runJson.ats.status).toBe("UNAVAILABLE");
    expect(runJson.ats.reasons).toContain("missing_commitments");
  });

  it("same idempotency key with different params is a 409 reuse conflict", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-proj-reuse");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");
    const key = randomUUID();
    const first = await postJson(base, "/api/projection/run", cookie, { workspaceId, horizonDays: 30, idempotencyKey: key });
    expect(first.status).toBe(200);
    const clash = await postJson(base, "/api/projection/run", cookie, { workspaceId, horizonDays: 60, idempotencyKey: key });
    expect(clash.status).toBe(409);
  });

  it("tenant-B run ids are indistinguishable from missing; unscoped reads return zero rows", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "e06-proj-tenant-a");
    const b = await setupWorkspace(base, "e06-proj-tenant-b");
    const accountId = await createAccount(base, a.cookie, a.workspaceId, "Cash");
    await createSnapshot(base, a.cookie, a.workspaceId, accountId, "1000.00");
    const run = (await runProjection(base, a.cookie, a.workspaceId, 30)).json as { runId: string };
    const foreign = await getJson(base, `/api/projection/runs/${run.runId}?workspaceId=${b.workspaceId}`, b.cookie);
    expect(foreign.status).toBe(404);
    const missing = await getJson(base, `/api/projection/runs/${randomUUID()}?workspaceId=${a.workspaceId}`, a.cookie);
    expect(missing.status).toBe(404);
    expect((foreign.json as { error: string }).error).toBe((missing.json as { error: string }).error);
    const unscopedRuns = await pool.query("SELECT COUNT(*)::int AS n FROM projection_runs");
    expect(Number((unscopedRuns.rows[0] as { n: number }).n)).toBe(0);
    const unscopedPoints = await pool.query("SELECT COUNT(*)::int AS n FROM projection_points");
    expect(Number((unscopedPoints.rows[0] as { n: number }).n)).toBe(0);
  });

  it("new inputs create a new run while the old run stays byte-identical", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-proj-immut");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");
    const first = (await runProjection(base, cookie, workspaceId, 30)).json as { runId: string; points: unknown[] };
    await setAssumption(base, cookie, workspaceId, "EXPECTED_INCOME", {
      amountMinor: "100000",
      currency: "EUR",
      cadence: "MONTHLY",
      dayOfMonth: 1,
    });
    const second = (await runProjection(base, cookie, workspaceId, 30)).json as { runId: string; points: unknown[] };
    expect(second.runId).not.toBe(first.runId);
    const reopened = (await getJson(base, `/api/projection/runs/${first.runId}?workspaceId=${workspaceId}`, cookie)).json as { points: { case_name: string; scope: string; point_date: string }[] };
    const order = (p: { case_name: string; scope: string; point_date: string }) => `${p.case_name}|${p.scope}|${p.point_date}`;
    const sortPoints = (ps: unknown[]) => [...(ps as { case_name: string; scope: string; point_date: string }[])].sort((x, y) => (order(x) < order(y) ? -1 : 1));
    expect(JSON.stringify(sortPoints(reopened.points))).toBe(JSON.stringify(sortPoints(first.points)));
  });
});