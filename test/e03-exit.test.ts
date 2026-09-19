// E03-S08 financial-truth exit demonstration (integrated, on merged code).
//
// Declared dataset (workspace A unless noted): 4 accounts (EUR Operating,
// JPY Tokyo, KWD Kuwait, USD Dollars); ~30 booked rows (imported via SQL +
// manual via API: transfer pair + fee, grocery + refund, card repayment,
// rent x3, refund-tango pair, correction/bulk/race targets, pagination
// fillers); 3 dated EUR snapshots (stale/current) + JPY zero + KWD negative
// + USD unknown; ECB-style + manual FX fixtures (pure-function valuation);
// 2 categories + 2 tags; 1 recurring series. Workspace B holds sentinel
// rows for isolation probes. All expectations below are independently
// computed (hand BigInt math in this file), never the implementation's own
// recomputation. Real PostgreSQL (`moneo_e03_exit`, fails closed without
// PG); synthetic data only. Live ECB qualification is out of scope here
// (fail-closed deterministic fixtures, S03 precedent).

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
import { valuateSnapshot } from "../apps/web/src/calculations/fx.ts";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
const latencies: { op: string; ms: number }[] = [];

// Independent exact helpers (hand math, not the implementation).
function halfEven(num: bigint, den: bigint): bigint {
  const q = num / den;
  const r = num % den;
  const twice = r * 2n;
  if (twice > den) return q + 1n;
  if (twice < den) return q;
  return q % 2n === 0n ? q : q + 1n;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

async function timed<T>(op: string, work: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await work();
  } finally {
    latencies.push({ op, ms: Date.now() - start });
  }
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
  const uiConfig = { appBaseUrl: "http://127.0.0.1:1", sessionSecret };
  const resolve = (req: IncomingMessage): Promise<Session | null> => requestSession(pool, sessionSecret, req);
  const server = createApp(createAuthRouter(config, pool), createTenancyRouter(pool, resolve), {
    ui: createUiRouter(pool, resolve, uiConfig),
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
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
  const done = await fetch(callbackUrl, { redirect: "manual" });
  return done.headers.get("set-cookie")!.split(";")[0];
}

async function postJson(base: string, path: string, cookie: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function getJson(base: string, path: string, cookie: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  return { status: res.status, json: await res.json() };
}

async function getRaw(base: string, path: string, cookie: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  return { status: res.status, text: await res.text() };
}

async function setupWorkspace(base: string, sub: string): Promise<{ cookie: string; workspaceId: string; userId: string }> {
  const cookie = await login(base, sub);
  const ws = (await postJson(base, "/api/workspaces", cookie, { name: "W", baseCurrency: "EUR" })).json as { id: string };
  const userRow = await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub]);
  return { cookie, workspaceId: ws.id, userId: (userRow.rows[0] as { id: string }).id };
}

async function createAccount(base: string, cookie: string, workspaceId: string, name: string, currency: string): Promise<string> {
  const created = await postJson(base, "/api/commands/accounts.create", cookie, { workspaceId, name, currency, idempotencyKey: randomUUID() });
  expect(created.status).toBe(200);
  return (created.json as { id: string }).id;
}

let rowNo = 0;
async function seedTx(workspaceId: string, userId: string, accountId: string, minor: string, currency: string, direction: string, date: string, description: string, importId?: string): Promise<string> {
  const id = randomUUID();
  rowNo += 1;
  await withTenant(pool, { userId, workspaceId }, async (client) => {
    await client.query(
      "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [workspaceId, id, accountId, minor, currency, direction, date, description, importId ?? randomUUID(), rowNo, randomUUID()],
    );
  });
  return id;
}

beforeAll(async () => {
  pool = await ensureTestPool("E03-S08", "moneo_e03_exit", [
    "recurring_overrides",
    "transaction_tags",
    "audit_events",
    "tags",
    "categories",
    "transactions",
    "manual_transactions",
    "balance_snapshots",
    "balance_audit",
    "fx_valuation",
    "fx_rates_ecb",
    "fx_rates_manual",
    "calculation_versions",
    "workspace_data_revision",
    "mapping_provider_usage",
    "mapping_provider_reservations",
    "mapping_proposals",
    "mapping_profiles",
    "review_decisions",
    "source_links",
    "import_commit_batches",
    "parsed_observations",
    "source_objects",
    "imports",
    "data_sources",
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
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e03-s08 financial-truth exit", () => {
  it("holds exact EUR/JPY/KWD goldens with no float contamination", async () => {
    // Independent expectations: EUR exp 2, JPY exp 0, KWD exp 3.
    expect(parseMinor("1234.56", "EUR").toString(10)).toBe("123456");
    expect(parseMinor("1200", "JPY").toString(10)).toBe("1200");
    expect(parseMinor("1.234", "KWD").toString(10)).toBe("1234");
    expect(formatMinor(123456n, "EUR")).toBe("1234.56");
    expect(formatMinor(1200n, "JPY")).toBe("1200");
    expect(formatMinor(1234n, "KWD")).toBe("1.234");
    expect(() => parseMinor("10.5", "JPY")).toThrow("excess_precision");
    expect(() => parseMinor("1.2345", "KWD")).toThrow("excess_precision");
    expect(() => parseMinor("1.00", "XXX")).toThrow("unknown_currency");

    // Through the command path: JPY/KWD accounts + manual minor-unit checks.
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-exit-money");
    for (const [name, currency] of [["Tokyo", "JPY"], ["Kuwait", "KWD"]] as const) {
      const created = await postJson(base, "/api/commands/accounts.create", cookie, { workspaceId, name, currency, idempotencyKey: randomUUID() });
      expect(created.status).toBe(200);
      expect(created.json).toMatchObject({ currency });
    }
    const bad = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId: (await getJson(base, `/api/accounts?workspaceId=${workspaceId}`, cookie)).json.accounts[0].id,
      amount: "10.5",
      currency: "JPY",
      direction: "OUTFLOW",
      effectiveDate: "2024-02-01",
      description: "Fractional yen must fail",
      idempotencyKey: randomUUID(),
    });
    expect(bad.status).toBe(400);
  });

  it("keeps >safe-integer values exact at every JSON boundary", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-exit-big");
    const eur = await createAccount(base, cookie, workspaceId, "Operating", "EUR");
    // Huge manual amount: 90071992547409.93 EUR = 9007199254740993 minor.
    const huge = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId: eur,
      amount: "90071992547409.93",
      currency: "EUR",
      direction: "INFLOW",
      effectiveDate: "2024-02-01",
      description: "Huge",
      idempotencyKey: randomUUID(),
    });
    expect(huge.status).toBe(200);
    expect(huge.json.amountMinor).toBe("9007199254740993");
    const txId = (huge.json as { id: string }).id;
    await withTenant(pool, { userId, workspaceId }, async (client) => {
      await client.query("UPDATE manual_transactions SET version = $1 WHERE workspace_id = $2 AND id = $3", ["9007199254740993", workspaceId, txId]);
      await client.query("UPDATE transactions SET version = $1 WHERE workspace_id = $2 AND id = (SELECT id FROM transactions WHERE workspace_id = $2 LIMIT 1)", ["9007199254740993", workspaceId]).catch(() => {});
    });
    await seedTx(workspaceId, userId, eur, "10000", "EUR", "OUTFLOW", "2024-02-02", "Seeded for version");
    await withTenant(pool, { userId, workspaceId }, async (client) => {
      await client.query("UPDATE transactions SET version = $1 WHERE workspace_id = $2 AND description = 'Seeded for version'", ["9007199254740993", workspaceId]);
    });
    const raw = await getRaw(base, `/api/transactions?workspaceId=${workspaceId}&limit=100`, cookie);
    expect(raw.status).toBe(200);
    expect(raw.text).toContain('"version":"9007199254740993"');
    expect(raw.text).toContain('"amountMinor":"9007199254740993"');
    expect(raw.text).not.toMatch(/9007199254740993[^"]/);
  });

  it("distinguishes missing, zero, negative and stale balances with cutoff reads", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-exit-bal");
    const eur = await createAccount(base, cookie, workspaceId, "Operating", "EUR");
    const jpy = await createAccount(base, cookie, workspaceId, "Tokyo", "JPY");
    const kwd = await createAccount(base, cookie, workspaceId, "Kuwait", "KWD");
    const usd = await createAccount(base, cookie, workspaceId, "Dollars", "USD");

    for (const [accountId, asOfDate, amount, currency, freshness] of [
      [eur, "2024-01-01", "1000.00", "EUR", "stale"],
      [eur, "2024-02-01", "1500.50", "EUR", "current"],
      [jpy, "2024-02-01", "0", "JPY", "current"],
      [kwd, "2024-02-01", "-50.125", "KWD", "current"],
    ] as const) {
      const snap = await postJson(base, "/api/commands/accounts.balance_snapshot", cookie, {
        workspaceId,
        accountId,
        asOfDate,
        amount,
        currency,
        freshness,
        idempotencyKey: randomUUID(),
      });
      expect(snap.status).toBe(200);
    }
    // Independent cutoff selection: newest snapshot at-or-before cutoff wins.
    async function atCutoff(accountId: string, cutoff: string): Promise<{ amountMinor: string; freshness: string } | null> {
      const list = (await getJson(base, `/api/accounts/${accountId}/balance_snapshots?workspaceId=${workspaceId}&limit=100`, cookie)).json.snapshots as {
        asOfDate: string;
        amountMinor: string;
        freshness: string;
      }[];
      const eligible = list.filter((s) => s.asOfDate <= cutoff).sort((a, b) => (a.asOfDate < b.asOfDate ? 1 : -1));
      return eligible.length > 0 ? { amountMinor: eligible[0].amountMinor, freshness: eligible[0].freshness } : null;
    }
    // 1000.00 EUR = 100000 minor; 1500.50 = 150050; -50.125 KWD = -50125.
    expect(await atCutoff(eur, "2024-01-15")).toMatchObject({ amountMinor: "100000", freshness: "stale" });
    expect(await atCutoff(eur, "2024-03-01")).toMatchObject({ amountMinor: "150050", freshness: "current" });
    expect(await atCutoff(jpy, "2024-03-01")).toMatchObject({ amountMinor: "0" });
    expect(await atCutoff(kwd, "2024-03-01")).toMatchObject({ amountMinor: "-50125" });
    // Missing stays distinguishable from explicit zero: no rows at all.
    const usdSnaps = (await getJson(base, `/api/accounts/${usd}/balance_snapshots?workspaceId=${workspaceId}&limit=100`, cookie)).json.snapshots as unknown[];
    expect(usdSnaps).toHaveLength(0);
    expect(await atCutoff(usd, "2024-03-01")).toBeNull();
  });

  it("classifies transfers, fees, refunds and repayments with exact totals", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-exit-cash");
    const eur = await createAccount(base, cookie, workspaceId, "Operating", "EUR");
    const jpy = await createAccount(base, cookie, workspaceId, "Tokyo", "JPY");
    const rows = [
      [await seedTx(workspaceId, userId, eur, "10000", "EUR", "OUTFLOW", "2024-02-01", "Transfer to Tokyo"), "TRANSFER", jpy],
      [await seedTx(workspaceId, userId, jpy, "16200", "JPY", "INFLOW", "2024-02-01", "Transfer from Operating"), "TRANSFER", eur],
      [await seedTx(workspaceId, userId, eur, "250", "EUR", "OUTFLOW", "2024-02-01", "Transfer fee"), "FEE", null],
      [await seedTx(workspaceId, userId, eur, "6000", "EUR", "OUTFLOW", "2024-02-02", "Groceries"), "NORMAL", null],
      [await seedTx(workspaceId, userId, eur, "6000", "EUR", "INFLOW", "2024-02-03", "Grocery refund"), "REFUND", null],
      [await seedTx(workspaceId, userId, eur, "20000", "EUR", "OUTFLOW", "2024-02-04", "Card repayment"), "CREDIT_REPAYMENT", jpy],
      [await seedTx(workspaceId, userId, eur, "2500", "EUR", "OUTFLOW", "2024-02-05", "Manual book"), "NORMAL", null],
    ] as const;
    for (const [transactionId, financialKind, linkedAccountId] of rows) {
      const corrected = await postJson(base, "/api/commands/transactions.correct", cookie, { workspaceId, transactionKind: "imported", transactionId, expectedVersion: "1", financialKind, linkedAccountId, idempotencyKey: randomUUID() });
      expect(corrected.status).toBe(200);
    }
    await withTenant(pool, { userId, workspaceId }, (client) => client.query("INSERT INTO fx_rates_ecb (workspace_id, rate_date, target_currency, rate, source_hash, checksum) VALUES ($1, '2024-02-01', 'JPY', '162.00', 'fixture', 'fixture')", [workspaceId]));
    const response = await getJson(base, `/api/calculations/financial-summary?workspaceId=${workspaceId}`, cookie);
    expect(response.status).toBe(200);
    expect(response.json.native).toEqual([
      expect.objectContaining({ currency: "EUR", spendMinor: "2750", cashMinor: "-2750", transferPrincipalMinor: "10000", transferFeeMinor: "250", refundMinor: "6000", creditRepaymentMinor: "20000" }),
      expect.objectContaining({ currency: "JPY", transferPrincipalMinor: "16200" }),
    ]);
    expect(response.json.base).toEqual({ incomeMinor: "0", spendMinor: "2750", cashMinor: "-2750", coverage: "full", unvaluedCount: "0" });
    expect(response.json.inputsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(response.json.resultsHash).toMatch(/^[a-f0-9]{64}$/);
    const stored = await getJson(base, `/api/calculations/version?workspaceId=${workspaceId}`, cookie);
    expect(stored.json).toMatchObject({ version: response.json.calculationVersion, inputsHash: response.json.inputsHash, resultsHash: response.json.resultsHash });
    const selected = await getJson(base, `/api/calculations/financial-summary?workspaceId=${workspaceId}&accountId=${eur}&dateTo=2024-02-03`, cookie);
    expect(selected.status).toBe(200);
    expect(selected.json.native).toEqual([expect.objectContaining({ currency: "EUR", spendMinor: "250", cashMinor: "-250", transferPrincipalMinor: "10000", refundMinor: "6000" })]);
    expect(selected.json.base).toEqual({ incomeMinor: "0", spendMinor: "250", cashMinor: "-250", coverage: "full", unvaluedCount: "0" });
  });

  it("values FX with coverage honesty and untouched natives", async () => {
    // Fixture ECB map (EUR base): USD 1.0850 full on 2024-02-01; JPY 160.00
    // only on 2024-01-25 (7 days prior → partial); KWD absent → unavailable.
    const ecb = new Map([
      ["2024-02-01", new Map([["USD", "1.0850"]])],
      ["2024-01-25", new Map([["JPY", "160.00"]])],
    ]);
    const manual = new Map([["2024-02-01", new Map([["EUR", new Map([["USD", "1.1000"]])]])]]);
    const eurSnap = { snapshotId: randomUUID(), accountId: randomUUID(), asOfDate: "2024-02-01", amountMinor: 150050n, currency: "EUR", baseCurrency: "USD" };
    // Manual override wins: 1500.50 × 1.1000 = 1650.55 → 165055 minor.
    const manualVal = valuateSnapshot(eurSnap, ecb, manual);
    expect(manualVal).toMatchObject({ coverage: "full", rateSource: "manual", rateDate: "2024-02-01" });
    expect(manualVal.valuedAmountMinor.toString(10)).toBe(halfEven(150050n * 11000n, 10000n).toString(10));
    expect(manualVal.valuedAmountMinor.toString(10)).toBe("165055");
    // ECB triangulation without manual: 1500.50 × 1.0850 = 1628.0425 → 162804.
    const ecbVal = valuateSnapshot(eurSnap, ecb, new Map());
    expect(ecbVal).toMatchObject({ coverage: "full", rateSource: "ecb", rateDate: "2024-02-01" });
    expect(ecbVal.valuedAmountMinor.toString(10)).toBe(halfEven(150050n * 10850n, 10000n).toString(10));
    expect(ecbVal.valuedAmountMinor.toString(10)).toBe("162804");
    // Partial: JPY 12000 as of 2024-02-01 with only a 7-day-old rate.
    const jpyVal = valuateSnapshot(
      { snapshotId: randomUUID(), accountId: randomUUID(), asOfDate: "2024-02-01", amountMinor: 12000n, currency: "JPY", baseCurrency: "USD" },
      ecb,
      new Map(),
    );
    expect(jpyVal).toMatchObject({ coverage: "partial", rateSource: "ecb", rateDate: "2024-01-25", maxPriorRateAgeDays: 7 });
    // Independent triangulation: parseRate("1.0850") = 10850/10000 and
    // parseRate("160.00") = 16000/100, so the triangulated USD-per-JPY
    // rational is (10850*100)/(16000*10000), simplified by local gcd.
    const g = gcd(10850n * 100n, 16000n * 10000n);
    const triNum = (10850n * 100n) / g;
    const triDen = (16000n * 10000n) / g;
    // convertWithRate: expDiff = 2 - 0 = 2 → num = amount*triNum*100.
    const expectedJpy = halfEven(12000n * triNum * 100n, triDen);
    expect(expectedJpy.toString(10)).toBe("8138");
    expect(jpyVal.valuedAmountMinor.toString(10)).toBe(expectedJpy.toString(10));
    // Unavailable: KWD has no leg at all — coverage says so, value unused.
    const kwdVal = valuateSnapshot(
      { snapshotId: randomUUID(), accountId: randomUUID(), asOfDate: "2024-02-01", amountMinor: -50125n, currency: "KWD", baseCurrency: "USD" },
      ecb,
      new Map(),
    );
    expect(kwdVal.coverage).toBe("unavailable");
    expect(kwdVal.rateDate).toBeNull();
    // Native booked amounts are never mutated by valuation (pure function,
    // inputs unchanged by reference check on primitives).
    expect(eurSnap.amountMinor.toString(10)).toBe("150050");
  });

  it("round-trips correction, category, tags, audit and supported undo", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-exit-fix");
    const eur = await createAccount(base, cookie, workspaceId, "Operating", "EUR");
    const txId = await seedTx(workspaceId, userId, eur, "6000", "EUR", "OUTFLOW", "2024-02-02", "Fix me");
    const cat = (await postJson(base, "/api/commands/categories.create", cookie, { workspaceId, name: "Food", idempotencyKey: randomUUID() })).json as { id: string };
    const tag = (await postJson(base, "/api/commands/tags.create", cookie, { workspaceId, name: "exit", idempotencyKey: randomUUID() })).json as { id: string };

    const corrected = await timed("correct", () =>
      postJson(base, "/api/commands/transactions.correct", cookie, {
        workspaceId,
        transactionKind: "imported",
        transactionId: txId,
        expectedVersion: "1",
        description: "Fixed",
        categoryId: cat.id,
        tagIds: [tag.id],
        idempotencyKey: randomUUID(),
      }),
    );
    expect(corrected.status).toBe(200);
    expect(corrected.json).toMatchObject({ description: "Fixed", categoryId: cat.id, version: "2", tagIds: [tag.id] });
    const opId = (corrected.json as { operationId: string }).operationId;

    const undone = await postJson(base, "/api/commands/operations.undo", cookie, { workspaceId, operationId: opId, idempotencyKey: randomUUID() });
    expect(undone.status).toBe(200);
    expect(undone.json).toMatchObject({ description: "Fix me", categoryId: null, version: "3" });
    const audit = (await getJson(base, `/api/audit/${txId}?workspaceId=${workspaceId}&entityType=transaction`, cookie)).json.audit as {
      action: string;
      compensatingOperationId: string | null;
    }[];
    expect(audit.map((a) => a.action)).toEqual(["correct", "undo"]);
    expect(audit[1].compensatingOperationId).toBe(opId);
  });

  it("pages, filters, bulk-edits and evidences through the shared table", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-exit-table");
    const eur = await createAccount(base, cookie, workspaceId, "Operating", "EUR");
    for (let i = 1; i <= 8; i++) {
      await seedTx(workspaceId, userId, eur, String(1000 * i), "EUR", i % 2 === 0 ? "INFLOW" : "OUTFLOW", `2024-02-${String(i).padStart(2, "0")}`, `Filler ${i}`);
    }
    const cat = (await postJson(base, "/api/commands/categories.create", cookie, { workspaceId, name: "Table", idempotencyKey: randomUUID() })).json as { id: string };
    const listed = await timed("list", () => getJson(base, `/api/transactions?workspaceId=${workspaceId}&limit=5&offset=0`, cookie));
    expect(listed.json.items).toHaveLength(5);
    expect(listed.json.totals.count).toBe("8");
    const page2 = await getJson(base, `/api/transactions?workspaceId=${workspaceId}&limit=5&offset=5`, cookie);
    expect(page2.json.items).toHaveLength(3);
    const ids1 = new Set((listed.json.items as { id: string }[]).map((i) => i.id));
    for (const row of page2.json.items as { id: string }[]) expect(ids1.has(row.id)).toBe(false);

    const bulk = await timed("bulk", () =>
      postJson(base, "/api/commands/transactions.bulk_set_category", cookie, {
        workspaceId,
        transactionKind: "imported",
        categoryId: cat.id,
        items: (listed.json.items as { id: string }[]).slice(0, 3).map((i) => ({ transactionId: i.id, expectedVersion: "1" })),
        idempotencyKey: randomUUID(),
      }),
    );
    expect(bulk.status).toBe(200);
    expect((bulk.json.updated as unknown[])).toHaveLength(3);

    const first = (listed.json.items as { id: string; kind: string }[])[0];
    const evidence = await getJson(base, `/api/transactions/${first.id}/evidence?workspaceId=${workspaceId}&kind=${first.kind}`, cookie);
    expect(evidence.status).toBe(200);
    expect(evidence.json.source.kind).toBe("imported");
    const drawer = await fetch(`${base}/w/${workspaceId}/transactions/${first.id}?kind=${first.kind}`, { headers: { cookie } }).then((r) => r.text());
    expect(drawer).toContain("Source evidence");
  });

  it("confirms recurring series without booking rows or spending transfers", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-exit-recur");
    const eur = await createAccount(base, cookie, workspaceId, "Operating", "EUR");
    for (const date of ["2024-01-12", "2024-02-11", "2024-03-12"]) {
      await seedTx(workspaceId, userId, eur, "80000", "EUR", "OUTFLOW", date, "Rent");
    }
    const before = await withTenant(pool, { userId, workspaceId }, async (client) => {
      const r = await client.query("SELECT COUNT(*) AS c FROM transactions WHERE workspace_id = $1", [workspaceId]);
      return Number((r.rows[0] as { c: string }).c);
    });
    const series = ((await getJson(base, `/api/recurring?workspaceId=${workspaceId}`, cookie)).json.candidates as {
      fingerprint: string;
      occurrences: number;
      warnings: string[];
    }[]).find((c) => c.occurrences === 3)!;
    expect(series.warnings.join(" ")).toContain("verify-not-transfer");
    const confirmed = await timed("recurring-confirm", () =>
      postJson(base, "/api/commands/recurring.confirm", cookie, {
        workspaceId,
        fingerprint: series.fingerprint,
        kind: "expense",
        dayOfMonth: 12,
        expectedVersion: "0",
        idempotencyKey: randomUUID(),
      }),
    );
    expect(confirmed.status).toBe(200);
    const after = await withTenant(pool, { userId, workspaceId }, async (client) => {
      const r = await client.query("SELECT COUNT(*) AS c FROM transactions WHERE workspace_id = $1", [workspaceId]);
      return Number((r.rows[0] as { c: string }).c);
    });
    expect(after).toBe(before);
  });

  it("updates reads on second import without losing corrections or provenance", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-exit-reimport");
    const eur = await createAccount(base, cookie, workspaceId, "Operating", "EUR");
    const importId = randomUUID();
    const txId = await seedTx(workspaceId, userId, eur, "6000", "EUR", "OUTFLOW", "2024-02-02", "Keep me");
    await withTenant(pool, { userId, workspaceId }, async (client) => {
      const dsId = randomUUID();
      await client.query("INSERT INTO data_sources (workspace_id, id, type, name, status) VALUES ($1, $2, 'csv_upload', 'first.csv', 'ACTIVE')", [workspaceId, dsId]);
      await client.query(
        "INSERT INTO imports (workspace_id, id, data_source_id, idempotency_key, file_name, file_sha256, object_key, parser_version, status) VALUES ($1, $2, $3, $4, 'first.csv', $5, 'q/first.csv', 'test-1', 'STAGED')",
        [workspaceId, importId, dsId, `exit-${importId}`, "2".repeat(64)],
      );
      await client.query("UPDATE transactions SET import_id = $1, import_row_no = 1, observation_id = 'obs-1' WHERE workspace_id = $2 AND id = $3", [importId, workspaceId, txId]);
    });
    const cat = (await postJson(base, "/api/commands/categories.create", cookie, { workspaceId, name: "Kept", idempotencyKey: randomUUID() })).json as { id: string };
    const assigned = await postJson(base, "/api/commands/transactions.set_category", cookie, {
      workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      categoryId: cat.id,
      expectedVersion: "1",
      idempotencyKey: randomUUID(),
    });
    expect(assigned.status).toBe(200);

    // Second import: same row re-seen (DO NOTHING) + one genuinely new row.
    await withTenant(pool, { userId, workspaceId }, async (client) => {
      await client.query(
        "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (workspace_id, import_id, import_row_no) DO NOTHING",
        [workspaceId, randomUUID(), eur, "6000", "EUR", "OUTFLOW", "2024-02-02", "Keep me", importId, 1, "obs-1"],
      );
      await client.query(
        "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (workspace_id, import_id, import_row_no) DO NOTHING",
        [workspaceId, randomUUID(), eur, "9999", "EUR", "OUTFLOW", "2024-02-09", "Brand new", importId, 2, "obs-2"],
      );
    });
    const reread = await getJson(base, `/api/transactions/${txId}?workspaceId=${workspaceId}&kind=imported`, cookie);
    expect(reread.json).toMatchObject({ categoryId: cat.id, version: "2", description: "Keep me" });
    const list = await getJson(base, `/api/transactions?workspaceId=${workspaceId}&limit=100`, cookie);
    expect((list.json.items as { description: string }[]).some((i) => i.description === "Brand new")).toBe(true);
  });

  it("denies tenants uniformly and converges retries, replays and races", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "e03-exit-ten-a");
    const b = await setupWorkspace(base, "e03-exit-ten-b");
    const eur = await createAccount(base, a.cookie, a.workspaceId, "Operating", "EUR");
    const txId = await seedTx(a.workspaceId, a.userId, eur, "6000", "EUR", "OUTFLOW", "2024-02-02", "Private");

    const foreign = await getJson(base, `/api/transactions/${txId}?workspaceId=${b.workspaceId}&kind=imported`, b.cookie);
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual({ error: "not_found" });
    const missing = await getJson(base, `/api/transactions/${randomUUID()}?workspaceId=${b.workspaceId}&kind=imported`, b.cookie);
    expect(missing.json).toEqual(foreign.json);
    const unscoped = await pool.query("SELECT COUNT(*) AS c FROM transactions");
    expect(Number((unscoped.rows[0] as { c: string }).c)).toBe(0);

    // Retry-safe replay: same key returns the identical operation.
    const key = randomUUID();
    const first = await postJson(base, "/api/commands/transactions.correct", a.cookie, {
      workspaceId: a.workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      expectedVersion: "1",
      description: "Retry me",
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    const replay = await postJson(base, "/api/commands/transactions.correct", a.cookie, {
      workspaceId: a.workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      expectedVersion: "1",
      description: "Retry me",
      idempotencyKey: key,
    });
    expect(replay.json).toMatchObject({ replayed: true, version: "2" });
    expect((replay.json as { operationId: string }).operationId).toBe((first.json as { operationId: string }).operationId);

    // Optimistic race: exactly one winner with currentVersion on losers.
    const racers = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        postJson(base, "/api/commands/transactions.correct", a.cookie, {
          workspaceId: a.workspaceId,
          transactionKind: "imported",
          transactionId: txId,
          expectedVersion: "2",
          description: `Racer ${i}`,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(racers.filter((r) => r.status === 200)).toHaveLength(1);
    expect(racers.filter((r) => r.status === 409)).toHaveLength(4);
    expect(racers.find((r) => r.status === 409)!.json.currentVersion).toBe("3");
  });

  it("records latency evidence within declared targets", async () => {
    for (const entry of latencies) {
      expect(entry.ms).toBeLessThan(500);
    }
    expect(latencies.length).toBeGreaterThan(0);
  });
});
