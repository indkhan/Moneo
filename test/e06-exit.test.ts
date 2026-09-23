// E06-S05 integrated exit demonstration (E06 EPICS exit on merged code).
//
// Declared dataset (fresh per test: workspace A under test + B for probes;
// synthetic only; real PG `moneo_e06_exit`, fails closed without PG). Full
// fixture (seedFull): 4 accounts (EUR/JPY/KWD/USD); 32 booked manual rows
// dated Oct-Dec 2023 (8/account; EUR leg holds a 3-row Rent series), strictly
// before every snapshot so forward-recon + in-horizon booked legs equal 0;
// snapshots 2024-01-01 (EUR 1000.00, JPY 12000, KWD 100.000, USD missing);
// 1 ECB-shaped FX row (USD 1.0850) + 1 manual EUR->USD row (1.1000);
// EXPECTED_VARIABLE_SPEND 0 (past spend weeks never leak daily events into
// hand-computed timelines); day-31 MONTHLY 800.00 + Feb-29 YEARLY 120.00
// schedules; 1 category + 1 tag (+1 assignment); 1 goal (5000.00) + 1
// reservation (400.00); 1 flat scenario (Trip + 900.00 on 2024-02-15; the
// date sits inside the 120d daily window so the exact-delta golden reads
// every day — long-horizon weekly aggregation is covered in scenarios.test).
// Projection-math legs use isolated EUR-only workspaces (same 2024-01-01
// anchor) so TOTAL stays hand-computable; multi-currency TOTAL is covered by
// the FX-gap UNAVAILABLE leg. All expectations are independently hand-computed
// decimal-string/BigInt oracles, never the implementation's echo. Runs allow
// 1..365d; the leap case is exercised via Feb-29 scheduling (2024 is leap).
// Measured (Win11, i5-12450HX, Node v22.23.2, local PG; 11/11 green): 21
// timed ops, worst run:154ms, all <500ms; in-suite 7263ms, vitest 8.44s
// (<120s). Honest local measurement, not an SLA.

import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import type { Session } from "../apps/web/src/session-store.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
import { formatMinor, parseMinor } from "../apps/web/src/money.ts";
import { createToolContext, executeTool } from "../apps/web/src/ai-tools.ts";
import { claimChatGeneration, createThread, sendTurn } from "../apps/web/src/chat.ts";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
const suiteStart = Date.now();
const latencies: { op: string; ms: number }[] = [];
const T = 30_000;
async function timed<T>(op: string, work: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try { return await work(); } finally { latencies.push({ op, ms: Date.now() - start }); }
}
async function startApp(): Promise<string> {
  const config: AuthConfig = { issuer: stub.base, clientId: STUB_CLIENT_ID, clientSecret: STUB_CLIENT_SECRET, appBaseUrl: "http://127.0.0.1:1", sessionSecret, sessionTtlSec: 43200 };
  const uiConfig = { appBaseUrl: "http://127.0.0.1:1", sessionSecret };
  const resolve = (req: IncomingMessage): Promise<Session | null> => requestSession(pool, sessionSecret, req);
  const server = createApp(createAuthRouter(config, pool), createTenancyRouter(pool, resolve), { ui: createUiRouter(pool, resolve, uiConfig) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  appServers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.appBaseUrl = base;
  uiConfig.appBaseUrl = base;
  return base;
}
async function login(base: string, loginAs: string): Promise<string> {
  const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const authorizeUrl = `${start.headers.get("location")!}&login_as=${loginAs}`;
  const callbackUrl = (await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!;
  return (await fetch(callbackUrl, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
}

async function postJson(base: string, path: string, cookie: string, body: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), text };
}
async function getJson(base: string, path: string, cookie: string): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), text };
}
async function getHtml(base: string, path: string, cookie: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  return { status: res.status, text: await res.text() };
}
async function postForm(base: string, path: string, cookie: string, fields: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(), redirect: "manual" });
  return { status: res.status, text: await res.text() };
}

async function setupWorkspace(base: string, sub: string): Promise<{ cookie: string; workspaceId: string; userId: string }> {
  const cookie = await login(base, sub);
  const ws = (await postJson(base, "/api/workspaces", cookie, { name: "W", baseCurrency: "EUR" })).json as { id: string };
  const userRow = await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub]);
  return { cookie, workspaceId: ws.id, userId: (userRow.rows[0] as { id: string }).id };
}

async function acct(base: string, cookie: string, workspaceId: string, name: string, currency: string): Promise<string> {
  const r = await postJson(base, "/api/commands/accounts.create", cookie, { workspaceId, name, currency, idempotencyKey: randomUUID() });
  expect(r.status).toBe(200);
  return (r.json as { id: string }).id;
}
async function snap(base: string, cookie: string, workspaceId: string, accountId: string, asOfDate: string, amount: string, currency: string, freshness = "current"): Promise<void> {
  const r = await postJson(base, "/api/commands/accounts.balance_snapshot", cookie, { workspaceId, accountId, asOfDate, amount, currency, freshness, idempotencyKey: randomUUID() });
  expect(r.status).toBe(200);
}
async function mtx(base: string, cookie: string, workspaceId: string, accountId: string, amount: string, currency: string, direction: string, date: string, description: string): Promise<string> {
  const r = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, { workspaceId, accountId, amount, currency, direction, effectiveDate: date, description, idempotencyKey: randomUUID() });
  expect(r.status).toBe(200);
  return (r.json as { id: string }).id;
}
async function assume(base: string, cookie: string, workspaceId: string, type: string, value: unknown, validFrom = "2024-01-01"): Promise<any> {
  const r = await postJson(base, "/api/commands/assumptions.set", cookie, { workspaceId, assumptionType: type, validFrom, value, idempotencyKey: randomUUID() });
  expect(r.status).toBe(200);
  return r.json;
}
async function run(base: string, cookie: string, workspaceId: string, horizonDays: number, spendingAccountId?: string): Promise<{ status: number; json: any }> {
  const r = await postJson(base, "/api/projection/run", cookie, { workspaceId, horizonDays, spendingAccountId, idempotencyKey: randomUUID() });
  return { status: r.status, json: r.json };
}
async function bookedCount(workspaceId: string, userId: string): Promise<number> {
  return withTenant(pool, { userId, workspaceId }, async (client) => {
    const a = await client.query("SELECT COUNT(*)::int AS n FROM transactions WHERE workspace_id = $1", [workspaceId]);
    const b = await client.query("SELECT COUNT(*)::int AS n FROM manual_transactions WHERE workspace_id = $1", [workspaceId]);
    return Number((a.rows[0] as { n: number }).n) + Number((b.rows[0] as { n: number }).n);
  });
}
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
async function seedOutflows(base: string, cookie: string, workspaceId: string, accountId: string, ccy: string, pairs: [string, string][], startDay: number, step: number): Promise<void> {
  for (const [i, [amount, desc]] of pairs.entries()) {
    await mtx(base, cookie, workspaceId, accountId, amount, ccy, "OUTFLOW", `2023-12-${String(startDay + i * step).padStart(2, "0")}`, desc);
  }
}

// Canonical header fixture. 32 booked rows (8/account, all Dec 2023 except
// the Oct/Nov Rent pair), snapshots 2024-01-01, variable-spend 0, day-31 +
// Feb-29 schedules, 1 category/tag, 1 goal + reservation, 1 scenario.
async function seedFull(base: string, sub: string): Promise<{ cookie: string; workspaceId: string; userId: string; eur: string; jpy: string; kwd: string; usd: string; goalId: string; scenarioId: string }> {
  const { cookie, workspaceId, userId } = await setupWorkspace(base, sub);
  const eur = await acct(base, cookie, workspaceId, "Operating", "EUR");
  const jpy = await acct(base, cookie, workspaceId, "Tokyo", "JPY");
  const kwd = await acct(base, cookie, workspaceId, "Kuwait", "KWD");
  const usd = await acct(base, cookie, workspaceId, "Dollars", "USD");
  await snap(base, cookie, workspaceId, eur, "2024-01-01", "1000.00", "EUR");
  await snap(base, cookie, workspaceId, jpy, "2024-01-01", "12000", "JPY");
  await snap(base, cookie, workspaceId, kwd, "2024-01-01", "100.000", "KWD");
  const rows: [string, string, string, string, string, string][] = [
    [eur, "3000.00", "EUR", "INFLOW", "2023-12-01", "Salary Dec"],
    [eur, "250.00", "EUR", "OUTFLOW", "2023-12-03", "Groceries"],
    [eur, "800.00", "EUR", "OUTFLOW", "2023-10-12", "Rent"],
    [eur, "800.00", "EUR", "OUTFLOW", "2023-11-12", "Rent"],
    [eur, "800.00", "EUR", "OUTFLOW", "2023-12-12", "Rent"],
    [eur, "45.50", "EUR", "OUTFLOW", "2023-12-15", "Utilities"],
    [eur, "500.00", "EUR", "INFLOW", "2023-12-20", "Bonus"],
    [eur, "60.00", "EUR", "OUTFLOW", "2023-12-22", "Dining"],
    [jpy, "200000", "JPY", "INFLOW", "2023-12-01", "Tokyo salary"],
  ];
  for (const [a, amount, ccy, dir, date, desc] of rows) await mtx(base, cookie, workspaceId, a, amount, ccy, dir, date, desc);
  await seedOutflows(base, cookie, workspaceId, jpy, "JPY", [["1200", "Tokyo dinner"], ["2500", "Transit"], ["800", "Lunch"], ["3100", "Groceries"], ["1500", "Books"], ["4200", "Dining"], ["900", "Gifts"]], 5, 3);
  await seedOutflows(base, cookie, workspaceId, kwd, "KWD", [["12.500", "Kuwait fuel"], ["8.250", "Lunch"], ["20.000", "Groceries"], ["5.500", "Transit"], ["33.125", "Dining"], ["7.750", "Books"], ["15.000", "Gifts"]], 4, 3);
  await mtx(base, cookie, workspaceId, kwd, "500.000", "KWD", "INFLOW", "2023-12-01", "Kuwait salary");
  await mtx(base, cookie, workspaceId, usd, "100.00", "USD", "INFLOW", "2023-12-10", "Refund");
  await seedOutflows(base, cookie, workspaceId, usd, "USD", [["10.00", "Coffee"], ["20.00", "Lunch"], ["5.00", "Transit"], ["7.50", "Books"], ["12.25", "Groceries"], ["3.75", "Snacks"], ["30.00", "Dining"]], 11, 1);
  await assume(base, cookie, workspaceId, "EXPECTED_VARIABLE_SPEND", { amountMinor: "0", currency: "EUR" });
  await assume(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", { amountMinor: "80000", currency: "EUR", cadence: "MONTHLY", dayOfMonth: 31, direction: "OUTFLOW", fingerprint: FP_A });
  await assume(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", { amountMinor: "12000", currency: "EUR", cadence: "YEARLY", month: 2, dayOfMonth: 29, direction: "OUTFLOW", fingerprint: FP_B });
  await withTenant(pool, { userId, workspaceId }, async (client) => {
    await client.query("INSERT INTO fx_rates_ecb (workspace_id, rate_date, target_currency, rate, source_hash, checksum) VALUES ($1, '2024-01-01', 'USD', '1.0850', 'exit', 'exit')", [workspaceId]);
    await client.query("INSERT INTO fx_rates_manual (workspace_id, rate_date, base_currency, target_currency, rate, auditor, source) VALUES ($1, '2024-01-01', 'EUR', 'USD', '1.1000', 'exit-fixture', 'synthetic')", [workspaceId]);
  });
  const cat = (await postJson(base, "/api/commands/categories.create", cookie, { workspaceId, name: "Food", idempotencyKey: randomUUID() })).json as { id: string };
  await postJson(base, "/api/commands/tags.create", cookie, { workspaceId, name: "exit", idempotencyKey: randomUUID() });
  const firstTx = (await getJson(base, `/api/transactions?workspaceId=${workspaceId}&limit=1&offset=0`, cookie)).json.items[0] as { id: string; kind: string };
  await postJson(base, "/api/commands/transactions.set_category", cookie, { workspaceId, transactionKind: firstTx.kind, transactionId: firstTx.id, categoryId: cat.id, expectedVersion: "1", idempotencyKey: randomUUID() });
  const goal = (await postJson(base, "/api/commands/goals.create", cookie, { workspaceId, name: "Emergency", goalType: "EMERGENCY_FUND", targetAmountMinor: "500000", currency: "EUR", idempotencyKey: randomUUID() })).json as { id: string };
  await postJson(base, "/api/commands/allocations.allocate", cookie, { workspaceId, goalId: goal.id, accountId: eur, amountMinor: "40000", currency: "EUR", idempotencyKey: randomUUID() });
  const scenario = (await postJson(base, "/api/commands/scenarios.create", cookie, { workspaceId, name: "Trip", idempotencyKey: randomUUID() })).json as { id: string };
  await postJson(base, "/api/commands/scenario-overrides.add", cookie, { workspaceId, scenarioId: scenario.id, overrideType: "ONE_TIME_EXPENSE", payload: { amountMinor: "90000", currency: "EUR", date: "2024-02-15", accountId: eur, description: "Flight" }, idempotencyKey: randomUUID() });
  return { cookie, workspaceId, userId, eur, jpy, kwd, usd, goalId: goal.id, scenarioId: scenario.id };
}

beforeAll(async () => {
  pool = await ensureTestPool("E06-S05", "moneo_e06_exit", [
    "scenario_overrides", "scenarios", "projection_runs", "projection_points", "projection_events", "projection_settings",
    "financial_assumptions", "goals", "goal_allocations", "recurring_overrides", "source_links", "transactions",
    "manual_transactions", "balance_snapshots", "balance_audit", "audit_events", "workspace_data_revision", "command_operations",
    "accounts", "imports", "workspace_members", "workspaces", "users", "app_sessions", "categories", "tags", "transaction_tags",
    "chat_threads", "chat_turns", "chat_attempts", "chat_activity", "chat_tool_calls", "artifacts", "artifact_versions",
    "artifact_build_attempts", "artifact_runtime_grants", "artifact_sdk_access_events", "artifact_state", "artifact_state_snapshots",
    "artifact_state_migrations", "artifact_ai_proposals", "ai_policies", "ai_exclusions", "ai_dispatch_permits",
    "ai_dispatch_budgets", "ai_dispatch_reservations", "ai_dispatch_usage", "fx_rates_ecb", "fx_rates_manual",
    "fx_valuation", "calculation_versions",
  ]);
  stub = await startStubIssuer();
}, 60_000);
afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (pool) await pool.end();
});

describe("e06-s05 exit: money, balances and dates", () => {
  it("holds EUR(2)/JPY(0)/KWD(3) goldens with >safe-integer raw-text exactness", async () => {
    // Independent: 1234.56 EUR = 123456; 1200 JPY = 1200; 1.234 KWD = 1234.
    expect(parseMinor("1234.56", "EUR").toString()).toBe("123456");
    expect(parseMinor("1200", "JPY").toString()).toBe("1200");
    expect(parseMinor("1.234", "KWD").toString()).toBe("1234");
    expect(formatMinor(123456n, "EUR")).toBe("1234.56");
    expect(formatMinor(1200n, "JPY")).toBe("1200");
    expect(formatMinor(1234n, "KWD")).toBe("1.234");
    expect(() => parseMinor("10.5", "JPY")).toThrow("excess_precision");
    expect(() => parseMinor("1.2345", "KWD")).toThrow("excess_precision");
    expect(() => parseMinor("1.00", "XXX")).toThrow("unknown_currency");

    const base = await startApp();
    const fx = await seedFull(base, "e06-exit-money");
    // 90071992547409.93 EUR = 9007199254740993 minor (> 2^53-1 = 9007199254740991).
    const huge = await postJson(base, "/api/commands/accounts.manual_transaction", fx.cookie, {
      workspaceId: fx.workspaceId, accountId: fx.eur, amount: "90071992547409.93", currency: "EUR", direction: "INFLOW",
      effectiveDate: "2024-02-01", description: "Beyond safe integer", idempotencyKey: randomUUID(),
    });
    expect(huge.status).toBe(200);
    expect(huge.json.amountMinor).toBe("9007199254740993");
    const listed = await timed("list", () => getJson(base, `/api/transactions?workspaceId=${fx.workspaceId}&limit=100`, fx.cookie));
    expect(listed.status).toBe(200);
    expect(listed.text).toContain('"amountMinor":"9007199254740993"');
    expect(listed.text).not.toMatch(/9007199254740993[^"]/);
    await withTenant(pool, { userId: fx.userId, workspaceId: fx.workspaceId }, async (client) => {
      await client.query("INSERT INTO goals (workspace_id, id, name, goal_type, target_amount_minor, currency_code, status, version) VALUES ($1, $2, 'Big', 'SAVINGS_TARGET', 100000, 'EUR', 'ACTIVE', 9007199254740993)", [fx.workspaceId, randomUUID()]);
    });
    const goals = await getJson(base, `/api/goals?workspaceId=${fx.workspaceId}`, fx.cookie);
    const bigGoal = (goals.json.goals as { id: string }[]).find((g) => (g as { name?: string }).name === "Big")!;
    const alloc = await postJson(base, "/api/commands/allocations.allocate", fx.cookie, {
      workspaceId: fx.workspaceId, goalId: bigGoal.id, accountId: fx.eur, amountMinor: "10000", currency: "EUR", idempotencyKey: randomUUID(),
    });
    expect(alloc.status).toBe(200);
    expect(alloc.text).toContain('"goalVersion":"9007199254740994"');
  }, T);
  it("distinguishes missing/zero/negative/stale balances with as-of cutoff reads", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-exit-bal");
    const eur = await acct(base, cookie, workspaceId, "Operating", "EUR");
    const jpy = await acct(base, cookie, workspaceId, "Tokyo", "JPY");
    const kwd = await acct(base, cookie, workspaceId, "Kuwait", "KWD");
    const usd = await acct(base, cookie, workspaceId, "Dollars", "USD");
    for (const [a, date, amount, ccy, fresh] of [
      [eur, "2024-01-01", "1000.00", "EUR", "stale"], [eur, "2024-02-01", "1500.50", "EUR", "current"],
      [jpy, "2024-02-01", "0", "JPY", "current"], [kwd, "2024-02-01", "-50.125", "KWD", "current"],
    ] as const) await snap(base, cookie, workspaceId, a, date, amount, ccy, fresh);
    async function atCutoff(accountId: string, cutoff: string): Promise<{ amountMinor: string; freshness: string } | null> {
      const list = (await getJson(base, `/api/accounts/${accountId}/balance_snapshots?workspaceId=${workspaceId}&limit=100`, cookie)).json.snapshots as { asOfDate: string; amountMinor: string; freshness: string }[];
      const eligible = list.filter((s) => s.asOfDate <= cutoff).sort((a, b) => (a.asOfDate < b.asOfDate ? 1 : -1));
      return eligible.length > 0 ? { amountMinor: eligible[0]!.amountMinor, freshness: eligible[0]!.freshness } : null;
    }
    // Independent: 1000.00 -> 100000; 1500.50 -> 150050; -50.125 KWD -> -50125.
    expect(await atCutoff(eur, "2024-01-15")).toMatchObject({ amountMinor: "100000", freshness: "stale" });
    expect(await atCutoff(eur, "2024-03-01")).toMatchObject({ amountMinor: "150050", freshness: "current" });
    expect(await atCutoff(jpy, "2024-03-01")).toMatchObject({ amountMinor: "0" });
    expect(await atCutoff(kwd, "2024-03-01")).toMatchObject({ amountMinor: "-50125" });
    const usdSnaps = (await getJson(base, `/api/accounts/${usd}/balance_snapshots?workspaceId=${workspaceId}&limit=100`, cookie)).json.snapshots as unknown[];
    expect(usdSnaps).toHaveLength(0);
    expect(await atCutoff(usd, "2024-03-01")).toBeNull();
    // Missing-balance engine behavior is pinned by the ATS matrix leg
    // (e06-ats-mb): spending from a snapshot-less account is UNAVAILABLE.
  }, T);

  it("reproduces month-end and leap-day daily balances exactly through the shared engine", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-exit-dates");
    const eur = await acct(base, cookie, workspaceId, "Cash", "EUR");
    await snap(base, cookie, workspaceId, eur, "2024-01-01", "1000.00", "EUR");
    await assume(base, cookie, workspaceId, "EXPECTED_VARIABLE_SPEND", { amountMinor: "0", currency: "EUR" });
    await assume(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", { amountMinor: "80000", currency: "EUR", cadence: "MONTHLY", dayOfMonth: 31, direction: "OUTFLOW", fingerprint: FP_A });
    await assume(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", { amountMinor: "12000", currency: "EUR", cadence: "YEARLY", month: 2, dayOfMonth: 29, direction: "OUTFLOW", fingerprint: FP_B });
    const res = await timed("run", () => run(base, cookie, workspaceId, 95));
    expect(res.status).toBe(200);
    const pts = res.json.points as { case_name: string; scope: string; point_date: string; amount_minor: string }[];
    const at = (c: string, scope: string, d: string): bigint => BigInt(pts.find((p) => p.case_name === c && p.scope === scope && p.point_date === d)!.amount_minor);
    // Independent hand math from start 100000 (2024 is a leap year).
    expect(at("EXPECTED", "TOTAL", "2024-01-30")).toBe(100000n);
    expect(at("EXPECTED", "TOTAL", "2024-01-31")).toBe(20000n); // -80000 day-31
    expect(at("EXPECTED", "TOTAL", "2024-02-28")).toBe(20000n); // nothing fires early
    expect(at("EXPECTED", "TOTAL", "2024-02-29")).toBe(-72000n); // -80000 clamped monthly + -12000 yearly
    expect(at("EXPECTED", "TOTAL", "2024-03-30")).toBe(-72000n);
    expect(at("EXPECTED", "TOTAL", "2024-03-31")).toBe(-152000n); // -80000 again
    expect(at("CONSERVATIVE", "TOTAL", "2024-01-31")).toBe(12000n); // 80000*1.1 = 88000
    expect(at("CONSERVATIVE", "TOTAL", "2024-02-29")).toBe(-89200n); // 12000-88000-13200
    expect(at("CONSERVATIVE", "TOTAL", "2024-03-31")).toBe(-177200n);
    expect(at("OPTIMISTIC", "TOTAL", "2024-01-31")).toBe(28000n); // 80000*0.9 = 72000
    expect(at("OPTIMISTIC", "TOTAL", "2024-02-29")).toBe(-54800n);
    // Single spendable account: TOTAL equals the account scope exactly.
    expect(at("EXPECTED", eur, "2024-02-29")).toBe(at("EXPECTED", "TOTAL", "2024-02-29"));
    expect(at("CONSERVATIVE", eur, "2024-01-31")).toBe(at("CONSERVATIVE", "TOTAL", "2024-01-31"));
  }, T);
});

describe("e06-s05 exit: reservations and ATS", () => {
  it("runs a 5-way allocation race with a single winner inside capacity and zero 5xx", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-exit-race");
    const eur = await acct(base, cookie, workspaceId, "Cash", "EUR");
    await snap(base, cookie, workspaceId, eur, "2024-01-01", "1000.00", "EUR");
    const goal = (await postJson(base, "/api/commands/goals.create", cookie, { workspaceId, name: "Fund", goalType: "SAVINGS_TARGET", targetAmountMinor: "500000", currency: "EUR", idempotencyKey: randomUUID() })).json as { id: string };
    // 5 x 600.00 against 1000.00 capacity: at most one can win (60000*2 > 100000).
    const raceBody = { workspaceId, goalId: goal.id, accountId: eur, amountMinor: "60000", currency: "EUR" };
    const racers = await Promise.all(Array.from({ length: 5 }, () => postJson(base, "/api/commands/allocations.allocate", cookie, { ...raceBody, idempotencyKey: randomUUID() })));
    expect(racers.filter((r) => r.status === 200)).toHaveLength(1);
    expect(racers.filter((r) => r.status === 409)).toHaveLength(4);
    expect(racers.filter((r) => r.status >= 500)).toHaveLength(0);
    const winner = racers.find((r) => r.status === 200)!;
    expect(winner.json.amountMinor).toBe("60000");
    expect(racers.filter((r) => r.status === 409)).toHaveLength(4);
    // Total within capacity; booked snapshot untouched (reservations are not cash).
    const view = (await getJson(base, `/api/goals/${goal.id}?workspaceId=${workspaceId}`, cookie)).json as { reservedMinor: string };
    expect(view.reservedMinor).toBe("60000");
    expect(BigInt(view.reservedMinor)).toBeLessThanOrEqual(100000n);
    const booked = (await getJson(base, `/api/accounts/${eur}/balance_snapshots?workspaceId=${workspaceId}&limit=1`, cookie)).json.snapshots[0] as { amountMinor: string };
    expect(booked.amountMinor).toBe("100000");
  }, T);

  it("returns the ATS matrix: available, shortfall-zero, and three unavailable reasons", async () => {
    const base = await startApp();
    async function eurWs(sub: string): Promise<{ cookie: string; workspaceId: string; eur: string }> {
      const { cookie, workspaceId } = await setupWorkspace(base, sub);
      const eur = await acct(base, cookie, workspaceId, "Cash", "EUR");
      await assume(base, cookie, workspaceId, "EXPECTED_VARIABLE_SPEND", { amountMinor: "0", currency: "EUR" });
      return { cookie, workspaceId, eur };
    }
    // Available: flat 1000.00, minimum headroom sits on day zero.
    {
      const { cookie, workspaceId, eur } = await eurWs("e06-ats-av");
      await snap(base, cookie, workspaceId, eur, "2024-01-01", "1000.00", "EUR");
      const r = await timed("ats-read", () => run(base, cookie, workspaceId, 30, eur));
      expect(r.json.ats).toMatchObject({ status: "AVAILABLE", amountMinor: "100000", limitingDay: "2024-01-01", limitingAccount: eur });
    }
    // Shortfall: 100.00 vs 200.00 monthly on day 5 -> 0 + 12000 shortfall.
    {
      const { cookie, workspaceId, eur } = await eurWs("e06-ats-sh");
      await snap(base, cookie, workspaceId, eur, "2024-01-01", "100.00", "EUR");
      await assume(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", { amountMinor: "20000", currency: "EUR", cadence: "MONTHLY", dayOfMonth: 5, direction: "OUTFLOW", accountId: eur, fingerprint: "d".repeat(64) });
      const r = await timed("ats-read", () => run(base, cookie, workspaceId, 10, eur));
      expect(r.json.ats).toMatchObject({ status: "SHORTFALL", amountMinor: "0", shortfallMinor: "12000", shortfallDate: "2024-01-05" });
    }
    // Unavailable: missing balance.
    {
      const { cookie, workspaceId, eur } = await eurWs("e06-ats-mb");
      const r = await timed("ats-read", () => run(base, cookie, workspaceId, 30, eur));
      expect(r.json.ats.status).toBe("UNAVAILABLE");
      expect(r.json.ats.reasons).toContain("missing_balance");
    }
    // Unavailable: FX gap (KWD has no ECB leg against EUR).
    {
      const { cookie, workspaceId } = await setupWorkspace(base, "e06-ats-fx");
      const kwd = await acct(base, cookie, workspaceId, "KWD Cash", "KWD");
      await assume(base, cookie, workspaceId, "EXPECTED_VARIABLE_SPEND", { amountMinor: "0", currency: "KWD" });
      await snap(base, cookie, workspaceId, kwd, "2024-01-01", "100.000", "KWD");
      const r = await timed("ats-read", () => run(base, cookie, workspaceId, 30, kwd));
      expect(r.json.ats.status).toBe("UNAVAILABLE");
      expect(r.json.ats.reasons).toContain("missing_fx");
    }
    // Unavailable: fingerprint-only assumption with no confirmed commitment.
    {
      const { cookie, workspaceId, eur } = await eurWs("e06-ats-mc");
      await snap(base, cookie, workspaceId, eur, "2024-01-01", "1000.00", "EUR");
      await assume(base, cookie, workspaceId, "EXPECTED_RECURRING_AMOUNT", { amountMinor: "50000", currency: "EUR", fingerprint: "f".repeat(64) });
      const r = await timed("ats-read", () => run(base, cookie, workspaceId, 30, eur));
      expect(r.json.ats.status).toBe("UNAVAILABLE");
      expect(r.json.ats.reasons).toContain("missing_commitments");
    }
  }, T);

  it("moves scopes on scheduled transfers with TOTAL unchanged; unscheduled shortfall is a funding gap", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-exit-xfer");
    const checking = await acct(base, cookie, workspaceId, "Checking", "EUR");
    const savings = await acct(base, cookie, workspaceId, "Savings", "EUR");
    await snap(base, cookie, workspaceId, checking, "2024-01-01", "1000.00", "EUR");
    await snap(base, cookie, workspaceId, savings, "2024-01-01", "500.00", "EUR");
    await assume(base, cookie, workspaceId, "EXPECTED_VARIABLE_SPEND", { amountMinor: "0", currency: "EUR" });
    await assume(base, cookie, workspaceId, "ONE_TIME_EXPECTED_EXPENSE", { amountMinor: "20000", currency: "EUR", direction: "OUTFLOW", date: "2024-01-10", accountId: checking, toAccountId: savings, description: "savings move" });
    const res = await timed("run", () => run(base, cookie, workspaceId, 30));
    expect(res.status).toBe(200);
    const pts = res.json.points as { case_name: string; scope: string; point_date: string; amount_minor: string }[];
    const at = (c: string, scope: string, d: string): bigint => BigInt(pts.find((p) => p.case_name === c && p.scope === scope && p.point_date === d)!.amount_minor);
    // Independent: 100000-20000 = 80000; 50000+20000 = 70000; TOTAL 150000.
    expect(at("EXPECTED", checking, "2024-01-09")).toBe(100000n);
    expect(at("EXPECTED", savings, "2024-01-09")).toBe(50000n);
    expect(at("EXPECTED", checking, "2024-01-10")).toBe(80000n);
    expect(at("EXPECTED", savings, "2024-01-10")).toBe(70000n);
    expect(at("EXPECTED", "TOTAL", "2024-01-10")).toBe(150000n);
    for (const c of ["CONSERVATIVE", "OPTIMISTIC"]) {
      expect(at(c, checking, "2024-01-10")).toBe(80000n);
      expect(at(c, savings, "2024-01-10")).toBe(70000n);
      expect(at(c, "TOTAL", "2024-01-10")).toBe(150000n);
    }
    // Without the scheduled leg, per-account failure is a funding gap, never silent cover.
    const g = await setupWorkspace(base, "e06-exit-gap");
    const gc = await acct(base, g.cookie, g.workspaceId, "Checking", "EUR");
    const gs = await acct(base, g.cookie, g.workspaceId, "Savings", "EUR");
    await snap(base, g.cookie, g.workspaceId, gc, "2024-01-01", "100.00", "EUR");
    await snap(base, g.cookie, g.workspaceId, gs, "2024-01-01", "5000.00", "EUR");
    await assume(base, g.cookie, g.workspaceId, "EXPECTED_VARIABLE_SPEND", { amountMinor: "0", currency: "EUR" });
    await assume(base, g.cookie, g.workspaceId, "EXPECTED_RECURRING_AMOUNT", { amountMinor: "20000", currency: "EUR", cadence: "MONTHLY", dayOfMonth: 5, direction: "OUTFLOW", accountId: gc, fingerprint: "e".repeat(64) });
    const gap = await timed("ats-read", () => run(base, g.cookie, g.workspaceId, 30));
    expect(gap.json.ats.status).toBe("UNAVAILABLE");
    expect(gap.json.ats.reasons).toContain("funding_gap");
    const scoped = await timed("ats-read", () => run(base, g.cookie, g.workspaceId, 30, gc));
    expect(scoped.json.ats).toMatchObject({ status: "SHORTFALL", amountMinor: "0", shortfallMinor: "12000", shortfallDate: "2024-01-05" });
  }, T);
});

describe("e06-s05 exit: scenarios, parity, isolation and latency", () => {
  it("keeps scenario deltas exact, booked rows unchanged, and original runs immutable on reopen", async () => {
    const base = await startApp();
    const fx = await seedFull(base, "e06-exit-scen");
    const before = await bookedCount(fx.workspaceId, fx.userId);
    expect(before).toBe(32);
    const cmp1 = await timed("compare", () => postJson(base, "/api/projection/compare", fx.cookie, { workspaceId: fx.workspaceId, scenarioId: fx.scenarioId, horizonDays: 120, idempotencyKey: randomUUID() }));
    expect(cmp1.status).toBe(200);
    const c1 = cmp1.json as { baselineInputHash: string; scenarioInputHash: string; horizonStart: string; aggregated: string; deltas: { case_name: string; scope: string; point_date: string; baseline_minor: string; scenario_minor: string; delta_minor: string }[] };
    expect(c1.horizonStart).toBe("2024-01-01");
    expect(c1.aggregated).toBe("daily");
    expect(c1.baselineInputHash).not.toBe(c1.scenarioInputHash);
    expect(c1.deltas.filter((d) => d.point_date < "2024-02-15")).toHaveLength(0);
    const flight = c1.deltas.filter((d) => d.case_name === "EXPECTED" && d.scope === fx.eur && d.point_date === "2024-02-15");
    expect(flight).toHaveLength(1);
    expect(BigInt(flight[0]!.delta_minor)).toBe(-90000n);
    expect(BigInt(flight[0]!.scenario_minor)).toBe(BigInt(flight[0]!.baseline_minor) - 90000n);
    const later = c1.deltas.find((d) => d.case_name === "EXPECTED" && d.scope === fx.eur && d.point_date === "2024-02-16");
    expect(BigInt(later!.delta_minor)).toBe(-90000n);
    expect(await bookedCount(fx.workspaceId, fx.userId)).toBe(before);
    // Persisted run, then a baseline change: new hash, original run byte-identical.
    const run1 = (await run(base, fx.cookie, fx.workspaceId, 30)).json as { runId: string; points: unknown[] };
    await assume(base, fx.cookie, fx.workspaceId, "EXPECTED_INCOME", { amountMinor: "100000", currency: "EUR", cadence: "MONTHLY", dayOfMonth: 1 });
    const cmp2 = (await postJson(base, "/api/projection/compare", fx.cookie, { workspaceId: fx.workspaceId, scenarioId: fx.scenarioId, horizonDays: 120, idempotencyKey: randomUUID() })).json as { scenarioInputHash: string };
    expect(cmp2.scenarioInputHash).not.toBe(c1.scenarioInputHash);
    const run2 = (await run(base, fx.cookie, fx.workspaceId, 30)).json as { runId: string };
    expect(run2.runId).not.toBe(run1.runId);
    const reopened = (await getJson(base, `/api/projection/runs/${run1.runId}?workspaceId=${fx.workspaceId}`, fx.cookie)).json as { points: { case_name: string; scope: string; point_date: string }[] };
    const sortPts = (ps: unknown[]): string => JSON.stringify([...(ps as { case_name: string; scope: string; point_date: string }[])].sort((x, y) => (`${x.case_name}|${x.scope}|${x.point_date}` < `${y.case_name}|${y.scope}|${y.point_date}` ? -1 : 1)));
    expect(sortPts(reopened.points)).toBe(sortPts(run1.points));
    expect(await bookedCount(fx.workspaceId, fx.userId)).toBe(before);
  }, T);

  it("agrees across HTTP run, UI projection page, AI forecast tool and SDK RPC", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e06-exit-parity");
    const eur = await acct(base, cookie, workspaceId, "Cash", "EUR");
    await snap(base, cookie, workspaceId, eur, "2024-01-01", "1000.00", "EUR");
    await assume(base, cookie, workspaceId, "EXPECTED_VARIABLE_SPEND", { amountMinor: "0", currency: "EUR" });
    await assume(base, cookie, workspaceId, "EXPECTED_INCOME", { amountMinor: "100000", currency: "EUR", cadence: "MONTHLY", dayOfMonth: 1 });
    const claims = { userId, workspaceId };
    // Independent: conservative income 90000 lands on day zero (100000+90000).
    const http = await timed("ats-read", () => run(base, cookie, workspaceId, 30, eur));
    expect(http.json.ats).toMatchObject({ status: "AVAILABLE", amountMinor: "190000", limitingDay: "2024-01-01", limitingAccount: eur });
    // UI projection page renders the same ATS via data-ats-* attributes.
    const page = await timed("ui", () => getHtml(base, `/w/${workspaceId}/projection?horizonDays=30&spendingAccountId=${eur}`, cookie));
    expect(page.status).toBe(200);
    const m = page.text.match(/data-ats-status="([A-Z]+)"[^>]*data-ats-amount="([^"]*)"/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("AVAILABLE");
    expect(m![2]).toBe("190000");
    const ctx = await createToolContext(pool, claims);
    const thread = await createThread(pool, claims, userId, { title: "exit parity" });
    const sent = await sendTurn(pool, claims, userId, { threadId: thread.id, body: "parity probe", idempotencyKey: randomUUID() });
    const claimed = await claimChatGeneration(pool, sent.jobId, { workerId: "e06-exit", leaseMs: 30_000 });
    if (!claimed) throw new Error("probe claim failed");
    const toolOut = await timed("tool", () => executeTool(pool, ctx, claimed.attemptId, 1, { name: "forecast.evaluate", args: { horizonDays: 30, spendingAccountId: eur } }));
    const toolAts = (toolOut.result as { ats: { status: string; amountMinor: string } }).ats;
    expect(toolAts.status).toBe("AVAILABLE");
    expect(toolAts.amountMinor).toBe("190000");
    const manifest = {
      artifactSdkVersion: "1", runtimeVersion: "1", sourceSchemaVersion: "1", stateSchemaVersion: "1",
      requestedPermissions: ["forecast.read"], approvedPermissions: ["forecast.read"],
      entrypoints: { full: "main", compact: "compact" }, resourceBudget: { maxMessagesPerSecond: 100 }, sourceHash: "", buildHash: "",
    };
    const draft = await postJson(base, "/api/artifacts", cookie, { workspaceId, name: "Exit forecast" });
    expect(draft.status).toBe(201);
    const artifactId = (draft.json as { artifactId: string }).artifactId;
    const published = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookie, {
      html: '<section><h1>Exit forecast</h1><div data-slot="chart"></div></section>',
      css: "section{font:16px system-ui;padding:1rem}",
      js: 'artifact.ui.render({ type: "chart", rows: [] });',
      manifest: JSON.stringify(manifest),
      expectedBaseVersionId: "",
      action: "publish",
    });
    expect(published.status).toBe(303);
    const versions = (await getJson(base, `/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, cookie)).json as { versions: { versionId: string; status: string }[] };
    const ready = versions.versions.find((v) => v.status === "ready")!;
    const session = await postJson(base, "/api/artifacts/sessions", cookie, { workspaceId, artifactId, versionId: ready.versionId });
    expect(session.status).toBe(201);
    const rpc = await timed("sdk", () => postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId: (session.json as { sessionId: string }).sessionId, method: "projection", args: { horizonDays: 30, spendingAccountId: eur } }));
    expect(rpc.status).toBe(200);
    const sdkAts = (rpc.json as { result: { ats: { status: string; amountMinor: string } } }).result.ats;
    expect(sdkAts.status).toBe("AVAILABLE");
    expect(sdkAts.amountMinor).toBe("190000");
    // All four legs identical for identical inputs.
    for (const leg of [m![2], toolAts.amountMinor, sdkAts.amountMinor]) expect(leg).toBe(http.json.ats.amountMinor);
  }, T);
  it("denies tenants uniformly, replays idempotent keys, and conflicts on stale versions", async () => {
    const base = await startApp();
    const a = await seedFull(base, "e06-exit-ten-a");
    const b = await setupWorkspace(base, "e06-exit-ten-b");
    const foreignGoal = await getJson(base, `/api/goals/${a.goalId}?workspaceId=${b.workspaceId}`, b.cookie);
    expect(foreignGoal.status).toBe(404);
    const missingGoal = await getJson(base, `/api/goals/${randomUUID()}?workspaceId=${a.workspaceId}`, a.cookie);
    expect(missingGoal.json).toEqual(foreignGoal.json);
    const foreignScen = await getJson(base, `/api/scenarios/${a.scenarioId}?workspaceId=${b.workspaceId}`, b.cookie);
    expect(foreignScen.status).toBe(404);
    const missingScen = await getJson(base, `/api/scenarios/${randomUUID()}?workspaceId=${a.workspaceId}`, a.cookie);
    expect(missingScen.json).toEqual(foreignScen.json);
    const runId = ((await run(base, a.cookie, a.workspaceId, 30)).json as { runId: string }).runId;
    const foreignRun = await getJson(base, `/api/projection/runs/${runId}?workspaceId=${b.workspaceId}`, b.cookie);
    expect(foreignRun.status).toBe(404);
    const missingRun = await getJson(base, `/api/projection/runs/${randomUUID()}?workspaceId=${a.workspaceId}`, a.cookie);
    expect((foreignRun.json as { error: string }).error).toBe((missingRun.json as { error: string }).error);
    const foreignSettings = await getJson(base, `/api/projection/settings?workspaceId=${a.workspaceId}`, b.cookie);
    expect(foreignSettings.status).toBe(404);
    for (const table of ["projection_runs", "projection_points", "goals", "goal_allocations", "scenarios", "scenario_overrides", "financial_assumptions"]) {
      const unscoped = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      expect(Number((unscoped.rows[0] as { n: number }).n)).toBe(0);
    }
    const incomeBody = { workspaceId: a.workspaceId, assumptionType: "EXPECTED_INCOME", validFrom: "2024-01-01", value: { amountMinor: "50000", currency: "EUR", cadence: "MONTHLY", dayOfMonth: 1 }, idempotencyKey: randomUUID() };
    const first = await postJson(base, "/api/commands/assumptions.set", a.cookie, incomeBody);
    expect(first.status).toBe(200);
    const replay = await postJson(base, "/api/commands/assumptions.set", a.cookie, incomeBody);
    expect(replay.json).toMatchObject({ replayed: true, id: (first.json as { id: string }).id });
    const runKey = randomUUID();
    const r1 = await postJson(base, "/api/projection/run", a.cookie, { workspaceId: a.workspaceId, horizonDays: 30, idempotencyKey: runKey });
    const r2 = await postJson(base, "/api/projection/run", a.cookie, { workspaceId: a.workspaceId, horizonDays: 30, idempotencyKey: runKey });
    expect((r2.json as { runId: string }).runId).toBe((r1.json as { runId: string }).runId);
    expect(r2.json).toMatchObject({ replayed: true });
    const clash = await postJson(base, "/api/projection/run", a.cookie, { workspaceId: a.workspaceId, horizonDays: 60, idempotencyKey: runKey });
    expect(clash.status).toBe(409);
    const settings = (await getJson(base, `/api/projection/settings?workspaceId=${a.workspaceId}`, a.cookie)).json as { version: string };
    const bumped = await postJson(base, "/api/commands/projection.settings.update", a.cookie, { workspaceId: a.workspaceId, expectedVersion: settings.version, horizonDays: 60, idempotencyKey: randomUUID() });
    expect(bumped.status).toBe(200);
    const staleSettings = await postJson(base, "/api/commands/projection.settings.update", a.cookie, { workspaceId: a.workspaceId, expectedVersion: settings.version, horizonDays: 61, idempotencyKey: randomUUID() });
    expect(staleSettings.status).toBe(409);
    expect(staleSettings.json).toMatchObject({ reason: "version_mismatch", currentVersion: (bumped.json as { version: string }).version });
    const archived = await postJson(base, "/api/commands/assumptions.archive", a.cookie, { workspaceId: a.workspaceId, assumptionId: (first.json as { id: string }).id, expectedVersion: "1", idempotencyKey: randomUUID() });
    expect(archived.status).toBe(200);
    const staleArchive = await postJson(base, "/api/commands/assumptions.archive", a.cookie, { workspaceId: a.workspaceId, assumptionId: (first.json as { id: string }).id, expectedVersion: "1", idempotencyKey: randomUUID() });
    expect(staleArchive.status).toBe(409);
    const freshGoal = (await postJson(base, "/api/commands/goals.create", a.cookie, { workspaceId: a.workspaceId, name: "Rename me", goalType: "SAVINGS_TARGET", targetAmountMinor: "100000", currency: "EUR", idempotencyKey: randomUUID() })).json as { id: string };
    const staleGoal = await postJson(base, "/api/commands/goals.update", a.cookie, { workspaceId: a.workspaceId, goalId: freshGoal.id, expectedVersion: "0", name: "Renamed", idempotencyKey: randomUUID() });
    expect(staleGoal.status).toBe(409);
    expect(staleGoal.json).toMatchObject({ currentVersion: "1" });
    // Planning surfaces stay server-rendered, labelled and script-free.
    for (const page of ["planning", "goals", "projection", "scenarios"]) {
      const html = await timed("ui", () => getHtml(base, `/w/${a.workspaceId}/${page}`, a.cookie));
      expect(html.status).toBe(200);
      expect(html.text).toContain("Skip to content");
      expect(html.text).not.toContain("<script");
    }
  }, T);

  it("reports baseline ok over 8+ spend weeks (never zero) and confirms recurring without booking", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-exit-base");
    const eur = await acct(base, cookie, workspaceId, "Cash", "EUR");
    const today = "2026-04-01";
    const preview0 = (await getJson(base, `/api/projection/baseline?workspaceId=${workspaceId}&today=${today}`, cookie)).json as { weeks: { start: string; end: string }[] };
    const pastWeeks = preview0.weeks.filter((w) => w.end < today);
    expect(pastWeeks.length).toBeGreaterThanOrEqual(8);
    const seeded: bigint[] = [];
    for (const [i, week] of pastWeeks.slice(0, 9).entries()) {
      const minor = 10000n + BigInt(i) * 500n;
      await mtx(base, cookie, workspaceId, eur, `${(minor / 100n).toString()}.${(minor % 100n).toString().padStart(2, "0")}`, "EUR", "OUTFLOW", week.start, `Baseline spend ${i}`);
      seeded.push(minor);
    }
    const preview = await timed("ats-read", () => getJson(base, `/api/projection/baseline?workspaceId=${workspaceId}&today=${today}`, cookie));
    const sorted = [...seeded].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const expectedMedian = sorted[Math.floor(sorted.length / 2)]!.toString();
    expect(preview.json).toMatchObject({ status: "ok", need: 8, medianMinor: expectedMedian, openImportCount: 0, pendingReviewCount: 0 });
    expect(preview.json.have).toBeGreaterThanOrEqual(8);
    const empty = await setupWorkspace(base, "e06-exit-base-empty");
    const thin = (await getJson(base, `/api/projection/baseline?workspaceId=${empty.workspaceId}&today=${today}`, empty.cookie)).json as { status: string; have: number; medianMinor: string | null };
    expect(thin).toMatchObject({ status: "insufficient", have: 0, medianMinor: null });
    // Recurring series confirms without booking rows or spending transfers.
    const r = await setupWorkspace(base, "e06-exit-recur");
    const rcash = await acct(base, r.cookie, r.workspaceId, "Cash", "EUR");
    for (const date of ["2024-01-12", "2024-02-11", "2024-03-12"]) {
      await mtx(base, r.cookie, r.workspaceId, rcash, "800.00", "EUR", "OUTFLOW", date, "Rent");
    }
    const beforeCount = await bookedCount(r.workspaceId, r.userId);
    const series = ((await getJson(base, `/api/recurring?workspaceId=${r.workspaceId}`, r.cookie)).json.candidates as { fingerprint: string; occurrences: number }[]).find((c) => c.occurrences === 3)!;
    const confirmed = await timed("ats-read", () => postJson(base, "/api/commands/recurring.confirm", r.cookie, { workspaceId: r.workspaceId, fingerprint: series.fingerprint, kind: "expense", dayOfMonth: 12, expectedVersion: "0", idempotencyKey: randomUUID() }));
    expect(confirmed.status).toBe(200);
    expect(await bookedCount(r.workspaceId, r.userId)).toBe(beforeCount);
  }, T);

  it("records latency evidence within declared targets", async () => {
    expect(latencies.length).toBeGreaterThan(0);
    const worst = latencies.reduce((x, y) => (y.ms > x.ms ? y : x), latencies[0]!);
    // eslint-disable-next-line no-console
    console.log(`e06-exit dataset: full fixture = 4 accounts, 32 booked rows, 3 snapshots (USD missing), 2 FX rows, 1 category+tag, 1 goal+reservation, 1 scenario+override; ops=${latencies.length} worst=${worst.op}:${worst.ms}ms suite=${Date.now() - suiteStart}ms`);
    for (const entry of latencies) expect(entry.ms, entry.op).toBeLessThan(500);
    expect(Date.now() - suiteStart).toBeLessThan(120_000);
  }, T);
});
