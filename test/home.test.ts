// E07-S02 trusted Home: server-rendered dashboard over shared queries only.
// Real disposable PostgreSQL (`moneo_e07_home`); deterministic scripted
// transports only — no live provider. Synthetic data only.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { Queue } from "bullmq";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant, type TenantClaims } from "../apps/web/src/tenancy.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
import { gateFindings } from "../apps/web/src/ui/home.ts";
import { dispatchOutbox, jobsQueue, type JobPayload } from "../apps/web/src/jobs.ts";
import { processCommitJob, DEFAULT_COMMIT_CONFIG, acceptImportCommitJob } from "../apps/web/src/import-commit.ts";
import { setAccountExclusion } from "../apps/web/src/ai-policy.ts";
import type { DispatchTransport } from "../apps/web/src/ai-dispatch.ts";
import { getBalances, getFinancialSummary } from "../apps/web/src/calculations/financial-summary.ts";
import { allocate, createGoal, listGoals } from "../apps/web/src/commands/goals.ts";
import { evaluateProjection } from "../apps/web/src/projections/engine.ts";
import {
  maybeTriggerDeepAnalysisTx,
  processDeepAnalysisJob,
  readAnalysisStatus,
} from "../apps/web/src/deep-analysis.ts";
import { ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
let redisUrl: string;
let queue: Queue<JobPayload>;

it("does not re-admit excluded evidence when findings share text", () => {
  const allowed = randomUUID();
  const excluded = randomUUID();
  const common = { workspaceId: randomUUID(), kind: "income", title: "Same", body: "Same", amountMinor: "10", currency: "EUR" };
  const findings = [
    { ...common, id: randomUUID(), evidence: [`account:${allowed}`] },
    { ...common, id: randomUUID(), evidence: [`account:${excluded}`] },
  ];
  expect(gateFindings(findings, new Set([allowed])).map((f) => f.id)).toEqual([findings[0]!.id]);
});

function homeRedisUrl(): string {
  const base = env("E07-S02", "REDIS_URL");
  const u = new URL(base);
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("E07-S02 refused: REDIS_URL must point at the local disposable Redis.");
  }
  const db = process.env["HOME_REDIS_DB"] ?? "11";
  if (!/^\d+$/.test(db) || Number(db) < 0 || Number(db) > 15) throw new Error("E07-S02 misconfigured: HOME_REDIS_DB must be 0-15.");
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
    {
      ui: createUiRouter(pool, (req) => requestSession(pool, sessionSecret, req), { appBaseUrl: "http://127.0.0.1:1", sessionSecret }),
      controls: null,
    },
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

type Setup = { cookie: string; userId: string; workspaceId: string; claims: TenantClaims };

async function setupWorkspace(base: string, sub: string, suffix: string): Promise<Setup> {
  const cookie = await login(base, sub);
  const ws = (await (await fetch(`${base}/api/workspaces`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `HOME-${suffix}`, baseCurrency: "EUR" }),
  })).json()) as { id: string };
  const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub])).rows[0] as { id: string }).id;
  return { cookie, userId, workspaceId: ws.id, claims: { userId, workspaceId: ws.id } };
}

async function get(cookie: string, url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { headers: { cookie } });
  return { status: res.status, text: await res.text() };
}

function scoped<T>(claims: TenantClaims, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(pool, claims, work);
}

// Home renders "this month" for the CURRENT month: fixtures must live in it,
// or the month section honestly reports zero for another month's data.
function monthDates(): { dateFrom: string; dateTo: string; d1: string; d2: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const last = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate();
  const pad = (d: number): string => `${y}-${m}-${String(Math.min(d, last)).padStart(2, "0")}`;
  return { dateFrom: `${y}-${m}-01`, dateTo: `${y}-${m}-${String(last).padStart(2, "0")}`, d1: pad(10), d2: pad(12) };
}

async function seedAccount(claims: TenantClaims, name: string): Promise<string> {
  return scoped(claims, async (client) => {
    const id = randomUUID();
    await client.query("INSERT INTO accounts (workspace_id, id, name, base_currency_code) VALUES ($1, $2, $3, 'EUR')", [claims.workspaceId, id, name]);
    return id;
  });
}

type SeedTx = { accountId: string; amountMinor: string; direction: "INFLOW" | "OUTFLOW"; date: string; desc: string };

async function seedTransactions(claims: TenantClaims, rows: SeedTx[]): Promise<void> {
  await scoped(claims, async (client) => {
    const importId = randomUUID();
    let rowNo = 0;
    for (const r of rows) {
      rowNo += 1;
      await client.query(
        "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id) VALUES ($1, $2, $3, $4, 'EUR', $5, $6, $7, $8, $9, $10)",
        [claims.workspaceId, randomUUID(), r.accountId, r.amountMinor, r.direction, r.date, r.desc, importId, rowNo, `obs-${rowNo}`],
      );
    }
  });
}

async function seedSnapshot(claims: TenantClaims, accountId: string, asOfDate: string, amountMinor: string): Promise<void> {
  await scoped(claims, async (client) => {
    await client.query(
      "INSERT INTO balance_snapshots (workspace_id, id, account_id, as_of_date, amount_minor, currency, source, freshness, reconciliation_state) VALUES ($1, $2, $3, $4, $5, 'EUR', 'manual', 'current', 'unreconciled')",
      [claims.workspaceId, randomUUID(), accountId, asOfDate, amountMinor],
    );
  });
}

async function seedGoal(claims: TenantClaims, accountId: string): Promise<string> {
  const created = await createGoal(pool, claims, claims.userId, {
    workspaceId: claims.workspaceId,
    name: "Emergency buffer",
    goalType: "EMERGENCY_FUND",
    targetAmountMinor: "100000",
    currency: "EUR",
    idempotencyKey: randomUUID(),
  });
  await allocate(pool, claims, claims.userId, {
    workspaceId: claims.workspaceId,
    goalId: created.view.id,
    accountId,
    amountMinor: "40000",
    currency: "EUR",
    idempotencyKey: randomUUID(),
  });
  return created.view.id;
}

type StagedRow = { amountMinor: string; direction: "INFLOW" | "OUTFLOW"; date: string; desc: string };

async function seedStagedImport(claims: TenantClaims, fileName: string, rows: StagedRow[]): Promise<string> {
  return scoped(claims, async (client) => {
    const dataSourceId = randomUUID();
    await client.query("INSERT INTO data_sources (workspace_id, id, type, name, status) VALUES ($1, $2, 'csv_upload', $3, 'ACTIVE')", [
      claims.workspaceId,
      dataSourceId,
      fileName,
    ]);
    const importId = randomUUID();
    await client.query(
      "INSERT INTO imports (workspace_id, id, data_source_id, idempotency_key, file_name, file_sha256, object_key, parser_version, status, row_count) VALUES ($1, $2, $3, $4, $5, $6, $7, 'test-1', 'STAGED', $8)",
      [claims.workspaceId, importId, dataSourceId, randomUUID(), fileName, randomBytes(32).toString("hex"), `quarantine/${importId}`, rows.length],
    );
    let rowNo = 0;
    for (const r of rows) {
      rowNo += 1;
      await client.query(
        "INSERT INTO parsed_observations (workspace_id, import_id, row_no, status, observation_id, amount_minor, currency, direction, effective_date, description) VALUES ($1, $2, $3, 'STAGED', $4, $5, 'EUR', $6, $7, $8)",
        [claims.workspaceId, importId, rowNo, `obs-${rowNo}`, r.amountMinor, r.direction, r.date, r.desc],
      );
    }
    return importId;
  });
}

async function commitImport(claims: TenantClaims, importId: string, accountId: string): Promise<string> {
  const accepted = await acceptImportCommitJob(pool, claims, claims.userId, {
    workspaceId: claims.workspaceId,
    idempotencyKey: randomUUID(),
    importId,
    accountId,
  });
  await dispatchOutbox(pool, queue);
  const outcome = await processCommitJob(pool, accepted.jobId, DEFAULT_COMMIT_CONFIG);
  if (outcome !== "applied") throw new Error(`commit failed with ${outcome}`);
  return accepted.jobId;
}

async function seedFindings(claims: TenantClaims, runId: string, rows: { kind: string; title: string; body: string; amountMinor: string | null; currency: string | null; evidence: string[] }[]): Promise<void> {
  await scoped(claims, async (client) => {
    // Explicit staggered created_at: same-transaction now() ties would leave
    // ORDER BY created_at, id to random-UUID order, so the 3-finding cap
    // could drop an arbitrary valid finding (intermittent oracle miss).
    // Staggering 1s per row makes insertion order the deterministic order.
    const base = Date.now();
    let rowNo = 0;
    for (const r of rows) {
      rowNo += 1;
      await client.query(
        "INSERT INTO deep_analysis_findings (workspace_id, id, run_id, kind, title, body, amount_minor, currency, evidence, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        [claims.workspaceId, randomUUID(), runId, r.kind, r.title, r.body, r.amountMinor, r.currency, JSON.stringify(r.evidence), new Date(base + rowNo * 1000).toISOString()],
      );
    }
  });
}

async function runIdOf(claims: TenantClaims): Promise<string | null> {
  return scoped(claims, async (client) => {
    const found = await client.query("SELECT id FROM deep_analysis_runs WHERE workspace_id = $1", [claims.workspaceId]);
    if ((found.rowCount ?? 0) === 0) return null;
    return (found.rows[0] as { id: string }).id;
  });
}

const failTransport: DispatchTransport = async () => ({
  httpStatus: null,
  bodyText: null,
  inputTokens: null,
  outputTokens: null,
  model: "home-fake",
});

beforeAll(async () => {
  pool = await ensureTestPool("E07-S02", "moneo_e07_home", [
    "deep_analysis_findings",
    "deep_analysis_steps",
    "deep_analysis_runs",
    "scenario_overrides",
    "scenarios",
    "projection_runs",
    "projection_points",
    "projection_events",
    "projection_settings",
    "financial_assumptions",
    "goals",
    "goal_allocations",
    "recurring_overrides",
    "chat_tool_calls",
    "chat_activity",
    "chat_attempts",
    "chat_turns",
    "chat_threads",
    "ai_dispatch_usage",
    "ai_dispatch_reservations",
    "ai_dispatch_budgets",
    "manual_transactions",
    "balance_snapshots",
    "balance_audit",
    "mapping_provider_usage",
    "mapping_provider_reservations",
    "mapping_proposals",
    "mapping_profiles",
    "review_decisions",
    "source_links",
    "transactions",
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
  redisUrl = homeRedisUrl();
  queue = jobsQueue(redisUrl);
  await queue.waitUntilReady();
  await queue.obliterate({ force: true });
}, 120_000);

afterAll(async () => {
  if (queue) await queue.close();
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e07-s02 trusted home", () => {
  it("renders trusted metrics equal to shared-query oracles, script-free", async () => {
    const base = await startApp();
    const { dateFrom, dateTo, d1, d2 } = monthDates();
    const setup = await setupWorkspace(base, "home-oracle", "oracle");
    const checking = await seedAccount(setup.claims, "Checking");
    await seedTransactions(setup.claims, [
      { accountId: checking, amountMinor: "50000", direction: "INFLOW", date: d1, desc: "Salary" },
      { accountId: checking, amountMinor: "20000", direction: "OUTFLOW", date: d2, desc: "Rent" },
    ]);
    await seedSnapshot(setup.claims, checking, d2, "50000");
    await seedGoal(setup.claims, checking);

    const balances = await getBalances(pool, setup.claims);
    const month = await getFinancialSummary(pool, setup.claims, setup.workspaceId, { dateFrom, dateTo });
    const projection = await evaluateProjection(pool, setup.claims, {});
    const goals = await listGoals(pool, setup.claims);

    const started = Date.now();
    const page = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    const elapsed = Date.now() - started;
    expect(page.status).toBe(200);
    expect(elapsed).toBeLessThan(2000);
    // Exact-money oracles from the shared queries — never AI text.
    expect(page.text).toContain(`${balances.balances[0]!.amount} minor EUR`);
    expect(page.text).toContain(`${month.base.incomeMinor} minor EUR`);
    expect(page.text).toContain(`${month.base.spendMinor} minor EUR`);
    expect(page.text).toContain(goals[0]!.name);
    expect(page.text).toContain(goals[0]!.reservedMinor);
    expect(page.text).toContain(projection.ats.status === "AVAILABLE" ? projection.ats.amountMinor : "Available to Spend");
    expect(page.text).not.toContain("<script");
    expect(page.text).toContain('name="viewport"');
    expect(page.text).toContain("Refresh");
    expect(page.text).toContain("/home/detail?section=balances");
    expect(page.text).toContain("/home/detail?section=projection");
  });

  it("accepted import + delayed provider still renders trusted metrics with progress, locally under 2s", async () => {
    const base = await startApp();
    const { d1, d2 } = monthDates();
    const setup = await setupWorkspace(base, "home-delayed", "delayed");
    const checking = await seedAccount(setup.claims, "Checking");
    const importId = await seedStagedImport(setup.claims, "month.csv", [
      { amountMinor: "70000", direction: "INFLOW", date: d1, desc: "Salary" },
      { amountMinor: "15000", direction: "OUTFLOW", date: d2, desc: "Groceries" },
    ]);
    await commitImport(setup.claims, importId, checking);
    await seedSnapshot(setup.claims, checking, d2, "55000");
    // Accepted commit emits the initial-run signal; the provider never runs
    // (transport missing/delayed) — Home must still be useful immediately.
    const status = await readAnalysisStatus(pool, setup.claims);
    expect(status).not.toBeNull();

    const started = Date.now();
    const page = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    const elapsed = Date.now() - started;
    expect(page.status).toBe(200);
    expect(elapsed).toBeLessThan(2000);
    expect(page.text).toContain(`Status: <strong>${status!.status}</strong>`);
    expect(page.text).toContain("70000 minor EUR");
    expect(page.text).toContain("55000 minor EUR");
    expect(page.text).not.toContain("<script");
  });

  it("failed provider renders trusted metrics plus error and retry, never a blank dashboard", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "home-failed", "failed");
    const checking = await seedAccount(setup.claims, "Checking");
    await seedTransactions(setup.claims, [{ accountId: checking, amountMinor: "80000", direction: "INFLOW", date: "2026-02-10", desc: "Salary Feb" }]);
    await seedSnapshot(setup.claims, checking, "2026-02-10", "80000");
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, randomUUID()));
    const found = await scoped(setup.claims, async (client) => client.query("SELECT job_id FROM deep_analysis_runs WHERE workspace_id = $1", [setup.workspaceId]));
    await processDeepAnalysisJob(pool, (found.rows[0] as { job_id: string }).job_id, failTransport);

    const page = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("FAILED_FINAL");
    expect(page.text).toContain("Retry analysis");
    expect(page.text).toContain("80000 minor EUR");
    expect(page.text).not.toContain("<script");
  });

  it("missing balances/FX render unavailable labels, never a false zero or complete net worth", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "home-missing", "missing");
    const checking = await seedAccount(setup.claims, "Checking");
    await seedTransactions(setup.claims, [{ accountId: checking, amountMinor: "10000", direction: "INFLOW", date: "2026-02-10", desc: "Gift" }]);
    // No snapshots: balances must be unavailable, not zero, not net worth.
    const page = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Balances unavailable");
    expect(page.text).not.toContain("Net worth: 0");
    // Empty workspace: month + goals + analysis empty states, no blank page.
    const empty = await setupWorkspace(base, "home-empty", "empty");
    const emptyPage = await get(empty.cookie, `${base}/w/${empty.workspaceId}/home`);
    expect(emptyPage.status).toBe(200);
    expect(emptyPage.text).toContain("No active goals yet");
    expect(emptyPage.text).toContain("No Deep Analysis yet");
    expect(emptyPage.text).toContain("Refresh");
  });

  it("findings appear only after evidence validation + current policy recheck; excluded sentinel never appears", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "home-gate", "gate");
    const checking = await seedAccount(setup.claims, "Checking");
    const hidden = await seedAccount(setup.claims, "Hidden");
    await seedTransactions(setup.claims, [
      { accountId: checking, amountMinor: "90000", direction: "INFLOW", date: "2026-02-10", desc: "Salary Feb" },
      { accountId: hidden, amountMinor: "41000", direction: "INFLOW", date: "2026-02-11", desc: "EXCLUDED-SENTINEL-77 hidden bonus" },
    ]);
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, randomUUID()));
    const run = (await runIdOf(setup.claims))!;
    await seedFindings(setup.claims, run, [
      { kind: "income", title: "Valid income finding", body: "Server-computed income.", amountMinor: "90000", currency: "EUR", evidence: ["calculation:1:abcdef"] },
      { kind: "income", title: "No-evidence amount", body: "Amount without evidence.", amountMinor: "123", currency: "EUR", evidence: [] },
      { kind: "income", title: "Excluded account finding EXCLUDED-SENTINEL-77", body: "Touches hidden.", amountMinor: "41000", currency: "EUR", evidence: [`account:${hidden}`] },
      { kind: "income", title: "Extra one", body: "Fourth valid.", amountMinor: "1", currency: "EUR", evidence: ["calculation:1:abcd"] },
      { kind: "income", title: "Extra two", body: "Fifth valid.", amountMinor: "2", currency: "EUR", evidence: ["calculation:1:abcd"] },
      { kind: "income", title: "Extra three", body: "Sixth valid.", amountMinor: "3", currency: "EUR", evidence: ["calculation:1:abcd"] },
    ]);
    // Current-policy recheck: excluding Hidden revokes the tainted finding.
    await setAccountExclusion(pool, setup.claims, setup.userId, hidden, true, "home-gate");

    const page = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Valid income finding");
    expect(page.text).not.toContain("No-evidence amount");
    expect(page.text).not.toContain("EXCLUDED-SENTINEL-77");
    // At most three expanded findings.
    const listed = (page.text.match(/\/home\/detail\?section=findings&amp;finding=/g) ?? []).length;
    expect(listed).toBeLessThanOrEqual(3);
  });

  it("second import updates metrics on reload without AI dispatch", async () => {
    const base = await startApp();
    const { d1, d2 } = monthDates();
    const setup = await setupWorkspace(base, "home-fresh", "fresh");
    const checking = await seedAccount(setup.claims, "Checking");
    await seedTransactions(setup.claims, [{ accountId: checking, amountMinor: "30000", direction: "INFLOW", date: d1, desc: "Salary" }]);
    const first = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    expect(first.text).toContain("30000 minor EUR");
    const before = await readAnalysisStatus(pool, setup.claims);

    await seedTransactions(setup.claims, [{ accountId: checking, amountMinor: "5000", direction: "OUTFLOW", date: d2, desc: "Books" }]);
    const second = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    expect(second.status).toBe(200);
    expect(second.text).toContain("5000 minor EUR");
    // No AI dispatch happened: analysis run state is untouched.
    expect(await readAnalysisStatus(pool, setup.claims)).toEqual(before);
  });

  it("detail links expose provenance and cap evidence at 50 rows; keyboard/44px/native semantics hold", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "home-detail", "detail");
    const checking = await seedAccount(setup.claims, "Checking");
    await seedTransactions(setup.claims, [{ accountId: checking, amountMinor: "60000", direction: "INFLOW", date: "2026-02-10", desc: "Salary Feb" }]);
    await seedSnapshot(setup.claims, checking, "2026-02-10", "60000");
    await seedGoal(setup.claims, checking);
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, randomUUID()));
    const run = (await runIdOf(setup.claims))!;
    await seedFindings(setup.claims, run, [
      { kind: "spending", title: "Big evidence finding", body: "Many refs.", amountMinor: "60000", currency: "EUR", evidence: Array.from({ length: 80 }, (_, i) => `transaction:ref-${i}`) },
    ]);

    for (const section of ["balances", "spend", "goals", "projection", "findings", "analysis"]) {
      const detail = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home/detail?section=${section}`);
      expect(detail.status).toBe(200);
      expect(detail.text).not.toContain("<script");
      expect(detail.text).toContain("Back to Home");
    }
    const finding = (await scoped(setup.claims, async (client) => client.query("SELECT id FROM deep_analysis_findings WHERE workspace_id = $1", [setup.workspaceId]))).rows[0] as { id: string };
    const evidence = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home/detail?section=findings&finding=${finding.id}`);
    expect(evidence.status).toBe(200);
    expect(evidence.text).toContain("cap 50");
    expect(evidence.text.match(/transaction:ref-/g)!.length).toBe(50);

    const home = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    // Keyboard: skip link + native anchors/buttons only (no JS handlers).
    expect(home.text).toContain('href="#main"');
    expect(home.text).not.toContain("onclick");
    expect(home.text).not.toContain("onkeydown");
    // 44px: every primary action carries the touch-target floor.
    const taps = home.text.match(/min-height:44px/g) ?? [];
    expect(taps.length).toBeGreaterThanOrEqual(6);
    const bad = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home/detail?section=nope`);
    expect(bad.status).toBe(404);
  });

  it("escapes hostile names and denies cross-tenant reads uniformly", async () => {
    const base = await startApp();
    const { d2 } = monthDates();
    const setup = await setupWorkspace(base, "home-escape", "escape");
    const hostile = await seedAccount(setup.claims, `<script>alert("x")</script>`);
    await seedSnapshot(setup.claims, hostile, d2, "100");
    const page = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    expect(page.status).toBe(200);
    expect(page.text).not.toContain(`<script>alert("x")</script>`);
    expect(page.text).toContain("&lt;script&gt;");

    const other = await setupWorkspace(base, "home-other", "other");
    const denied = await get(other.cookie, `${base}/w/${setup.workspaceId}/home`);
    expect(denied.status).toBe(404);
    expect(denied.text).toContain("No such workspace");
  });

  it("serves Home under 2s on a 10k-row synthetic fixture", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "home-perf", "perf");
    const checking = await seedAccount(setup.claims, "Checking");
    const rows: SeedTx[] = Array.from({ length: 10_000 }, (_, i) => ({
      accountId: checking,
      amountMinor: String(100 + (i % 900)),
      direction: i % 3 === 0 ? ("INFLOW" as const) : ("OUTFLOW" as const),
      date: `2026-02-${String((i % 28) + 1).padStart(2, "0")}`,
      desc: `Bulk row ${i}`,
    }));
    await seedTransactions(setup.claims, rows);
    await seedSnapshot(setup.claims, checking, "2026-02-28", "100000");

    const started = Date.now();
    const page = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    const elapsed = Date.now() - started;
    expect(page.status).toBe(200);
    expect(elapsed).toBeLessThan(2000);
  }, 120_000);
});
