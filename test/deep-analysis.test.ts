// E07-S01 one bounded initial Deep Analysis: first accepted import batch
// starts one saved, bounded analysis; progress/stop/retry/reopen work; later
// refresh needs no model call. Real disposable PostgreSQL
// (`moneo_e07_analysis`) + real Redis (dedicated logical DB 10,
// loopback-guarded; only it is flushed); deterministic scripted transports
// only — no live provider. Synthetic data only.

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
import { dispatchOutbox, jobsQueue, type JobPayload } from "../apps/web/src/jobs.ts";
import { claimAttempt, checkpointAttempt, reconcileTransport } from "../apps/web/src/job-recovery.ts";
import { migrate } from "../apps/web/src/db.ts";
import { processCommitJob, DEFAULT_COMMIT_CONFIG, acceptImportCommitJob } from "../apps/web/src/import-commit.ts";
import { setAccountExclusion } from "../apps/web/src/ai-policy.ts";
import { setDispatchBudget, type DispatchTransport } from "../apps/web/src/ai-dispatch.ts";
import { getFinancialSummary } from "../apps/web/src/calculations/financial-summary.ts";
import { allocate, createGoal, listGoals, updateGoal } from "../apps/web/src/commands/goals.ts";
import { evaluateProjection } from "../apps/web/src/projections/engine.ts";
import {
  AnalysisError,
  buildFindings,
  DEEP_ANALYSIS_MAX_ATTEMPTS,
  maybeTriggerDeepAnalysisTx,
  processDeepAnalysisJob,
  readAnalysisDetail,
  readAnalysisStatus,
  retryAnalysis,
  stopAnalysis,
  validateFindings,
} from "../apps/web/src/deep-analysis.ts";
import { ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
let redisUrl: string;
let queue: Queue<JobPayload>;

function deepRedisUrl(): string {
  const base = env("E07-S01", "REDIS_URL");
  const u = new URL(base);
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("E07-S01 refused: REDIS_URL must point at the local disposable Redis.");
  }
  const db = process.env["DEEP_REDIS_DB"] ?? "10";
  if (!/^\d+$/.test(db) || Number(db) < 0 || Number(db) > 15) throw new Error("E07-S01 misconfigured: DEEP_REDIS_DB must be 0-15.");
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
    body: JSON.stringify({ name: `DA-${suffix}`, baseCurrency: "EUR" }),
  })).json()) as { id: string };
  const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub])).rows[0] as { id: string }).id;
  return { cookie, userId, workspaceId: ws.id, claims: { userId, workspaceId: ws.id } };
}

async function call(method: string, url: string, cookie: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(url, {
    method,
    headers: { cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch { /* html pages */ }
  return { status: res.status, json, text };
}

async function scoped<T>(claims: TenantClaims, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(pool, claims, work);
}

// ---- Synthetic seed helpers (exact minor units, EUR single-currency) ----

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

async function analysisJobId(claims: TenantClaims): Promise<string | null> {
  return scoped(claims, async (client) => {
    const found = await client.query("SELECT job_id FROM deep_analysis_runs WHERE workspace_id = $1", [claims.workspaceId]);
    if ((found.rowCount ?? 0) === 0) return null;
    return (found.rows[0] as { job_id: string | null }).job_id;
  });
}

async function runAnalysis(claims: TenantClaims, transport: DispatchTransport): Promise<string> {
  const jobId = await analysisJobId(claims);
  if (!jobId) throw new Error("no analysis job to run");
  await dispatchOutbox(pool, queue);
  return processDeepAnalysisJob(pool, jobId, transport);
}

// Deterministic scripted transports: first dispatch emits one evidence tool
// call, the second closes with a short analyst note. No live provider.
function scriptTransport(accountIds: string[]): DispatchTransport {
  let n = 0;
  return async () => {
    n += 1;
    if (n === 1) {
      return {
        httpStatus: 200,
        bodyText: JSON.stringify({ tool_calls: [{ name: "finance.totals", args: { accountIds } }] }),
        inputTokens: 100,
        outputTokens: 50,
        model: "deep-analysis-fake",
      };
    }
    return {
      httpStatus: 200,
      bodyText: JSON.stringify({ final: "Steady household: income covers spend with margin." }),
      inputTokens: 100,
      outputTokens: 30,
      model: "deep-analysis-fake",
    };
  };
}

const failTransport: DispatchTransport = async () => ({
  httpStatus: null,
  bodyText: null,
  inputTokens: null,
  outputTokens: null,
  model: "deep-analysis-fake",
});

beforeAll(async () => {
  pool = await ensureTestPool("E07-S01", "moneo_e07_analysis", [
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
    "workspace_data_revision",
    "calculation_versions",
    "accounts",
    "workspace_members",
    "workspaces",
    "users",
    "app_sessions",
  ]);
  stub = await startStubIssuer();
  redisUrl = deepRedisUrl();
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

describe("e07-s01 bounded initial deep analysis", () => {
  it("coalesces two commits, duplicate completion and a second import into one initial analysis", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "deep-coalesce", "coalesce");
    const checking = await seedAccount(setup.claims, "Checking");
    const impA = await seedStagedImport(setup.claims, "march-a.csv", [
      { amountMinor: "200000", direction: "INFLOW", date: "2026-03-15", desc: "Salary March" },
      { amountMinor: "80000", direction: "OUTFLOW", date: "2026-03-05", desc: "Rent March" },
    ]);
    const jobA = await commitImport(setup.claims, impA, checking);
    // Duplicate completion delivery converges without a second effect.
    expect(await processCommitJob(pool, jobA, DEFAULT_COMMIT_CONFIG)).toBe("duplicate-terminal-noop");
    let run = await scoped(setup.claims, async (client) => (await client.query("SELECT * FROM deep_analysis_runs WHERE workspace_id = $1", [setup.workspaceId])).rows[0] as { id: string; status: string; commit_ids: string[]; window_closed_at: string | null });
    expect(run.status).toBe("QUEUED");
    expect(run.commit_ids).toEqual([impA]);

    const impB = await seedStagedImport(setup.claims, "march-b.csv", [{ amountMinor: "350", direction: "OUTFLOW", date: "2026-03-02", desc: "Coffee" }]);
    await commitImport(setup.claims, impB, checking);
    run = await scoped(setup.claims, async (client) => (await client.query("SELECT * FROM deep_analysis_runs WHERE workspace_id = $1", [setup.workspaceId])).rows[0] as { id: string; status: string; commit_ids: string[]; window_closed_at: string | null });
    expect(run.commit_ids).toEqual([impA, impB]);
    const jobs = await scoped(
      setup.claims,
      async (client) => (await client.query("SELECT count(*)::int AS n FROM background_jobs WHERE workspace_id = $1 AND job_type = 'deep-analysis.run'", [setup.workspaceId])).rows[0] as { n: number },
    );
    expect(jobs.n).toBe(1);

    // Batch window semantics on the claim fence: +90s joins, +11min closes.
    const t0 = Date.now();
    const impC = randomUUID();
    const first = await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, impC, t0));
    expect(first.created).toBe(false);
    expect(first.runId).toBe(run.id);
    const impD = randomUUID();
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, impD, t0 + 90_000));
    run = await scoped(setup.claims, async (client) => (await client.query("SELECT * FROM deep_analysis_runs WHERE workspace_id = $1", [setup.workspaceId])).rows[0] as { id: string; status: string; commit_ids: string[]; window_closed_at: string | null });
    expect(run.commit_ids).toEqual([impA, impB, impC, impD]);
    // Regression: +5min is past the 2-minute quiet window, so it does NOT
    // join the same batch, yet exactly one initial run still stands.
    const impF = randomUUID();
    const late = await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, impF, t0 + 5 * 60_000));
    expect(late.created).toBe(false);
    expect(late.runId).toBe(run.id);
    const impE = randomUUID();
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, impE, t0 + 11 * 60_000));
    run = await scoped(setup.claims, async (client) => (await client.query("SELECT * FROM deep_analysis_runs WHERE workspace_id = $1", [setup.workspaceId])).rows[0] as { id: string; status: string; commit_ids: string[]; window_closed_at: string | null });
    expect(run.commit_ids).toEqual([impA, impB, impC, impD]);
    expect(run.window_closed_at).not.toBeNull();
    const runCount = await scoped(
      setup.claims,
      async (client) => (await client.query("SELECT count(*)::int AS n FROM deep_analysis_runs WHERE workspace_id = $1", [setup.workspaceId])).rows[0] as { n: number },
    );
    expect(runCount.n).toBe(1);
    // Drain the coalesced run so later global sweeps see a clean index.
    expect(await runAnalysis(setup.claims, scriptTransport([checking]))).toBe("applied");
    expect((await readAnalysisStatus(pool, setup.claims))!.status).toBe("SUCCEEDED");
  });

  it("publishes exact evidence: every number reproduces via shared queries at the frozen cutoff", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "deep-evidence", "evidence");
    const checking = await seedAccount(setup.claims, "Checking");
    const savings = await seedAccount(setup.claims, "Savings");
    await seedTransactions(setup.claims, [
      { accountId: checking, amountMinor: "200000", direction: "INFLOW", date: "2026-01-15", desc: "Salary" },
      { accountId: checking, amountMinor: "200000", direction: "INFLOW", date: "2026-02-15", desc: "Salary" },
      { accountId: checking, amountMinor: "80000", direction: "OUTFLOW", date: "2026-01-05", desc: "Rent" },
      { accountId: checking, amountMinor: "80000", direction: "OUTFLOW", date: "2026-02-05", desc: "Rent" },
      { accountId: checking, amountMinor: "80000", direction: "OUTFLOW", date: "2026-03-05", desc: "Rent" },
      { accountId: checking, amountMinor: "350", direction: "OUTFLOW", date: "2026-01-02", desc: "Coffee" },
      { accountId: checking, amountMinor: "12500", direction: "OUTFLOW", date: "2026-02-10", desc: "Groceries" },
      { accountId: savings, amountMinor: "5000", direction: "INFLOW", date: "2026-01-20", desc: "Dividend" },
    ]);
    await seedSnapshot(setup.claims, checking, "2026-01-31", "150000");
    await seedSnapshot(setup.claims, savings, "2026-01-31", "50000");
    const goalId = await seedGoal(setup.claims, checking);

    const t0 = Date.now();
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, randomUUID(), t0));
    const outcome = await runAnalysis(setup.claims, scriptTransport([checking, savings]));
    expect(outcome).toBe("applied");

    const detail = (await readAnalysisDetail(pool, setup.claims))!;
    expect(detail.status).toBe("SUCCEEDED");
    expect(detail.report).not.toBeNull();
    expect(detail.dispatchesUsed).toBeLessThanOrEqual(4);
    expect(detail.toolCallsUsed).toBeLessThanOrEqual(8);
    expect(detail.tokensReserved).toBeLessThanOrEqual(20_000);
    expect(BigInt(detail.costReservedMinor)).toBeLessThanOrEqual(100n);

    // Independent oracles through the same shared queries at the frozen cutoff.
    const cutoffDate = detail.cutoffAt!.slice(0, 10);
    const summary = await getFinancialSummary(pool, setup.claims, setup.workspaceId, { dateTo: cutoffDate });
    expect(summary.base.incomeMinor).toBe("405000");
    expect(summary.base.spendMinor).toBe("252850");
    const byKind = new Map(detail.findings.map((f) => [f.kind, f]));
    expect(byKind.get("spending")!.amountMinor).toBe(summary.base.spendMinor);
    expect(byKind.get("income")!.amountMinor).toBe(summary.base.incomeMinor);
    expect(byKind.get("spending")!.currency).toBe("EUR");
    expect(byKind.get("recurring")!.body).toContain("2 recurring candidates");
    const goals = await listGoals(pool, setup.claims);
    const goal = goals.find((g) => g.id === goalId)!;
    expect(goal.reservedMinor).toBe("40000");
    expect(byKind.get("goal")!.amountMinor).toBe("60000");
    expect(byKind.get("goal")!.evidence).toContain(`goal:${goalId}`);
    const eligible = await scoped(setup.claims, async (client) => (await client.query("SELECT id FROM accounts WHERE workspace_id = $1 AND archived = false ORDER BY id", [setup.workspaceId])).rows as { id: string }[]);
    const projection = await evaluateProjection(pool, setup.claims, { eligibleAccountIds: eligible.map((r) => r.id) });
    const projFinding = byKind.get("projection")!;
    expect(projFinding.evidence).toContain(`projection:${projection.inputHash.slice(0, 16)}`);
    if (projection.ats.status === "AVAILABLE") {
      expect(projFinding.amountMinor).toBe((projection.ats as { amountMinor: string }).amountMinor);
    } else {
      expect(projFinding.amountMinor).toBeNull();
    }

    // HTTP status/detail + page link honour the same saved state.
    const status = await call("GET", `${base}/api/analysis/status?workspaceId=${setup.workspaceId}`, setup.cookie);
    expect(status.status).toBe(200);
    expect((status.json as { status: string }).status).toBe("SUCCEEDED");
    const httpDetail = await call("GET", `${base}/api/analysis/detail?workspaceId=${setup.workspaceId}`, setup.cookie);
    expect(httpDetail.status).toBe(200);
    expect(((httpDetail.json as { findings: unknown[] }).findings).length).toBe(detail.findings.length);
    const wsPage = await fetch(`${base}/w/${setup.workspaceId}`, { headers: { cookie: setup.cookie, accept: "text/html" } });
    const wsHtml = await wsPage.text();
    expect(wsHtml).toContain(`/w/${setup.workspaceId}/analysis`);
    const analysisPage = await fetch(`${base}/w/${setup.workspaceId}/analysis`, { headers: { cookie: setup.cookie, accept: "text/html" } });
    const analysisHtml = await analysisPage.text();
    expect(analysisPage.status).toBe(200);
    expect(analysisHtml).toContain("Observed spending");

    // A later import updates shared reads without restarting the analysis.
    await seedTransactions(setup.claims, [{ accountId: checking, amountMinor: "10000", direction: "INFLOW", date: "2026-03-20", desc: "Bonus" }]);
    const fresh = await getFinancialSummary(pool, setup.claims, setup.workspaceId, {});
    expect(fresh.base.incomeMinor).toBe("415000");
    const reopened = (await readAnalysisDetail(pool, setup.claims))!;
    expect(reopened.status).toBe("SUCCEEDED");
    expect((reopened.report as { incomeMinor: string }).incomeMinor).toBe("405000");
    expect(reopened.findings).toHaveLength(detail.findings.length);
  });

  it("does not publish a frozen finding after a goal changes during provider execution", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "deep-goal-race", "goal-race");
    const checking = await seedAccount(setup.claims, "Checking");
    await seedSnapshot(setup.claims, checking, "2026-01-31", "100000");
    const goalId = await seedGoal(setup.claims, checking);
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, randomUUID()));
    let changed = false;
    const transport: DispatchTransport = async () => {
      if (!changed) {
        changed = true;
        const goal = (await listGoals(pool, setup.claims)).find((g) => g.id === goalId)!;
        await updateGoal(pool, setup.claims, setup.userId, {
          workspaceId: setup.workspaceId, goalId, expectedVersion: goal.version,
          targetAmountMinor: "120000", currency: "EUR", idempotencyKey: randomUUID(),
        });
      }
      return { httpStatus: 200, bodyText: JSON.stringify({ final: "Goal changed." }), inputTokens: 10, outputTokens: 10, model: "deep-analysis-fake" };
    };
    expect(await runAnalysis(setup.claims, transport)).toBe("failed-final");
    const detail = (await readAnalysisDetail(pool, setup.claims))!;
    expect(detail.errorCode).toBe("stale_data");
    expect(detail.findings).toHaveLength(0);
    await retryAnalysis(pool, setup.claims, setup.userId);
    expect(await runAnalysis(setup.claims, scriptTransport([checking]))).toBe("applied");
    const retried = (await readAnalysisDetail(pool, setup.claims))!;
    expect(retried.findings.find((f) => f.kind === "goal")?.amountMinor).toBe("80000");
  });

  it("names pending-review and excluded coverage gaps without unsupported claims", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "deep-coverage", "coverage");
    const checking = await seedAccount(setup.claims, "Checking");
    const hidden = await seedAccount(setup.claims, "Hidden");
    await seedTransactions(setup.claims, [
      { accountId: checking, amountMinor: "100000", direction: "INFLOW", date: "2026-01-15", desc: "Salary Jan" },
      { accountId: checking, amountMinor: "30000", direction: "OUTFLOW", date: "2026-01-05", desc: "Rent Jan" },
      { accountId: hidden, amountMinor: "90000", direction: "INFLOW", date: "2026-01-16", desc: "Hidden income" },
    ]);
    // One row awaiting review + one excluded account: both must be named.
    // The pending link points at a real staged import (FK-honest fixture).
    const pendingImport = await seedStagedImport(setup.claims, "pending.csv", [
      { amountMinor: "4200", direction: "OUTFLOW", date: "2026-01-09", desc: "Ambiguous charge" },
    ]);
    await scoped(setup.claims, async (client) => {
      await client.query(
        "INSERT INTO source_links (workspace_id, id, import_id, import_row_no, observation_id, status) VALUES ($1, $2, $3, 999, 'obs-999', 'PENDING_REVIEW')",
        [setup.workspaceId, randomUUID(), pendingImport],
      );
    });
    await setAccountExclusion(pool, setup.claims, setup.userId, hidden, true, "coverage-probe");
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, randomUUID()));
    expect(await runAnalysis(setup.claims, scriptTransport([checking]))).toBe("applied");
    const detail = (await readAnalysisDetail(pool, setup.claims))!;
    expect(detail.status).toBe("SUCCEEDED");
    const kinds = detail.coverageWarnings.map((w) => w.kind);
    expect(kinds).toContain("pending_review");
    expect(kinds).toContain("excluded_accounts");
    const excluded = detail.coverageWarnings.find((w) => w.kind === "excluded_accounts")!;
    expect((excluded as { names: string[] }).names).toContain("Hidden");
    expect((detail.report as { coverage: string }).coverage).toBe("partial");
    const coverageFinding = detail.findings.find((f) => f.kind === "coverage")!;
    expect(coverageFinding.body).toContain("pending_review:1");
    // Exclusions apply before aggregation: eligible-only numbers publish.
    const byKind = new Map(detail.findings.map((f) => [f.kind, f]));
    expect(byKind.get("income")!.amountMinor).toBe("100000");
    expect(byKind.get("spending")!.amountMinor).toBe("30000");
    for (const f of detail.findings) {
      for (const ref of f.evidence) {
        expect(ref).not.toContain(hidden);
      }
    }
  });

  it("resumes once after a crash past the baseline checkpoint", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "deep-crash", "crash");
    const checking = await seedAccount(setup.claims, "Checking");
    await seedTransactions(setup.claims, [
      { accountId: checking, amountMinor: "50000", direction: "INFLOW", date: "2026-01-15", desc: "Salary Jan" },
      { accountId: checking, amountMinor: "10000", direction: "OUTFLOW", date: "2026-01-05", desc: "Rent Jan" },
    ]);
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, randomUUID()));
    const jobId = (await analysisJobId(setup.claims))!;
    await dispatchOutbox(pool, queue);
    // Simulate a worker dying after the baseline checkpoint: short lease,
    // claim + checkpoint, then let the lease lapse.
    const { resolveJobRoute } = await import("../apps/web/src/jobs.ts");
    const route = (await resolveJobRoute(pool, jobId))!;
    const first = await claimAttempt(pool, { ...route, jobId }, "crash-worker-1", 200, "bull-1");
    expect((await checkpointAttempt(pool, { ...route, jobId }, { attemptId: first.attemptId, generation: first.generation }, "analysis-baseline")).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 450));
    expect(await processDeepAnalysisJob(pool, jobId, scriptTransport([checking]))).toBe("applied");
    const attempts = await scoped(
      setup.claims,
      async (client) => (await client.query("SELECT generation, status FROM background_job_attempts WHERE workspace_id = $1 AND background_job_id = $2 ORDER BY attempt_no", [setup.workspaceId, jobId])).rows as { generation: string; status: string }[],
    );
    expect(attempts.map((a) => a.status)).toEqual(["STALE", "SUCCEEDED"]);
    expect((await readAnalysisStatus(pool, setup.claims))!.status).toBe("SUCCEEDED");
  });

  it("recovers from total queue loss via PostgreSQL and honours Stop/queued-cancel", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "deep-queue", "queue");
    const checking = await seedAccount(setup.claims, "Checking");
    await seedTransactions(setup.claims, [{ accountId: checking, amountMinor: "70000", direction: "INFLOW", date: "2026-01-15", desc: "Salary Jan" }]);
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, randomUUID()));
    // Lose the transport entirely, then reconcile from durable truth.
    await queue.obliterate({ force: true });
    const recovered = await reconcileTransport(pool, queue);
    expect(recovered.enqueued).toBe(1);
    expect(await runAnalysis(setup.claims, scriptTransport([checking]))).toBe("applied");
    expect((await readAnalysisStatus(pool, setup.claims))!.status).toBe("SUCCEEDED");

    // Stop while queued cancels immediately with nothing published.
    const setup2 = await setupWorkspace(base, "deep-stop-q", "stopq");
    const checking2 = await seedAccount(setup2.claims, "Checking");
    await seedTransactions(setup2.claims, [{ accountId: checking2, amountMinor: "1000", direction: "INFLOW", date: "2026-01-15", desc: "Tiny" }]);
    await scoped(setup2.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup2.workspaceId, setup2.userId, randomUUID()));
    const stopped = await stopAnalysis(pool, setup2.claims);
    expect(stopped.status).toBe("CANCELLED");
    const jobId2 = (await analysisJobId(setup2.claims))!;
    await dispatchOutbox(pool, queue);
    expect(await processDeepAnalysisJob(pool, jobId2, scriptTransport([checking2]))).toBe("duplicate-terminal-noop");
    const detail2 = (await readAnalysisDetail(pool, setup2.claims))!;
    expect(detail2.findings).toHaveLength(0);
    expect(detail2.report).toBeNull();
  });

  it("fences late publication when Stop lands mid-run", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "deep-stoprun", "stoprun");
    const checking = await seedAccount(setup.claims, "Checking");
    await seedTransactions(setup.claims, [{ accountId: checking, amountMinor: "60000", direction: "INFLOW", date: "2026-01-15", desc: "Salary Jan" }]);
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, randomUUID()));
    let stopped = false;
    const cancelling: DispatchTransport = async () => {
      if (!stopped) {
        stopped = true;
        await stopAnalysis(pool, setup.claims);
      }
      return { httpStatus: 200, bodyText: JSON.stringify({ final: "Late note." }), inputTokens: 10, outputTokens: 10, model: "deep-analysis-fake" };
    };
    const jobId = (await analysisJobId(setup.claims))!;
    await dispatchOutbox(pool, queue);
    expect(await processDeepAnalysisJob(pool, jobId, cancelling)).toBe("duplicate-terminal-noop");
    const detail = (await readAnalysisDetail(pool, setup.claims))!;
    expect(detail.status).toBe("CANCELLED");
    expect(detail.findings).toHaveLength(0);
    expect(detail.report).toBeNull();
  });

  it("fails closed on provider failure with a usable retry, and enforces the attempt limit", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "deep-provider", "provider");
    const checking = await seedAccount(setup.claims, "Checking");
    await seedTransactions(setup.claims, [{ accountId: checking, amountMinor: "80000", direction: "INFLOW", date: "2026-01-15", desc: "Salary Jan" }]);
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, randomUUID()));
    expect(await runAnalysis(setup.claims, failTransport)).toBe("failed-final");
    let detail = (await readAnalysisDetail(pool, setup.claims))!;
    expect(detail.status).toBe("FAILED_FINAL");
    expect(detail.errorCode).toBe("provider_unavailable");
    expect(detail.findings).toHaveLength(0);
    expect(detail.report).toBeNull();
    // No fabricated report: nothing published under total provider failure.
    expect(await runAnalysis(setup.claims, scriptTransport([checking]))).toBe("duplicate-terminal-noop");
    const retried = await retryAnalysis(pool, setup.claims, setup.userId);
    expect(retried.status).toBe("QUEUED");
    expect(await runAnalysis(setup.claims, scriptTransport([checking]))).toBe("applied");
    detail = (await readAnalysisDetail(pool, setup.claims))!;
    expect(detail.status).toBe("SUCCEEDED");
    expect(detail.attemptCount).toBe("2");
    expect(detail.findings.length).toBeGreaterThan(0);

    // Second failure exhausts the two attempts: retry is refused.
    const setup2 = await setupWorkspace(base, "deep-attempts", "attempts");
    const checking2 = await seedAccount(setup2.claims, "Checking");
    await seedTransactions(setup2.claims, [{ accountId: checking2, amountMinor: "1000", direction: "INFLOW", date: "2026-01-15", desc: "Tiny" }]);
    await scoped(setup2.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup2.workspaceId, setup2.userId, randomUUID()));
    expect(await runAnalysis(setup2.claims, failTransport)).toBe("failed-final");
    await retryAnalysis(pool, setup2.claims, setup2.userId);
    expect(await runAnalysis(setup2.claims, failTransport)).toBe("failed-final");
    await expect(retryAnalysis(pool, setup2.claims, setup2.userId)).rejects.toMatchObject({ code: "attempt_limit" });
    const stale = (await readAnalysisStatus(pool, setup2.claims))!;
    expect(stale.attemptCount).toBe(String(DEEP_ANALYSIS_MAX_ATTEMPTS));
  });

  it("revalidates grants: revocation fails the run closed, retry succeeds on current policy", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "deep-revoke", "revoke");
    const checking = await seedAccount(setup.claims, "Checking");
    await seedTransactions(setup.claims, [{ accountId: checking, amountMinor: "90000", direction: "INFLOW", date: "2026-01-15", desc: "Salary Jan" }]);
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, randomUUID()));
    let revoked = false;
    const revoking: DispatchTransport = async () => {
      if (!revoked) {
        revoked = true;
        await setAccountExclusion(pool, setup.claims, setup.userId, checking, true, "revoke-probe");
      }
      return { httpStatus: 200, bodyText: JSON.stringify({ final: "Stale note." }), inputTokens: 10, outputTokens: 10, model: "deep-analysis-fake" };
    };
    expect(await runAnalysis(setup.claims, revoking)).toBe("failed-final");
    const detail = (await readAnalysisDetail(pool, setup.claims))!;
    expect(detail.status).toBe("FAILED_FINAL");
    expect(detail.errorCode).toBe("policy_revoked");
    expect(detail.report).toBeNull();
    await retryAnalysis(pool, setup.claims, setup.userId);
    expect(await runAnalysis(setup.claims, scriptTransport([]))).toBe("applied");
    const recovered = (await readAnalysisDetail(pool, setup.claims))!;
    expect(recovered.status).toBe("SUCCEEDED");
  });

  it("respects the workspace budget cap and keeps reserved cost within it", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "deep-budget", "budget");
    const checking = await seedAccount(setup.claims, "Checking");
    await seedTransactions(setup.claims, [
      { accountId: checking, amountMinor: "120000", direction: "INFLOW", date: "2026-01-15", desc: "Salary Jan" },
      { accountId: checking, amountMinor: "40000", direction: "OUTFLOW", date: "2026-01-05", desc: "Rent Jan" },
    ]);
    await setDispatchBudget(pool, setup.claims, { moneyMinor: "5", tokens: 40000, concurrency: 5 });
    await scoped(setup.claims, (client) => maybeTriggerDeepAnalysisTx(client, setup.workspaceId, setup.userId, randomUUID()));
    expect(await runAnalysis(setup.claims, scriptTransport([checking]))).toBe("applied");
    const detail = (await readAnalysisDetail(pool, setup.claims))!;
    expect(detail.status).toBe("SUCCEEDED");
    expect(detail.dispatchesUsed).toBe(0);
    expect(BigInt(detail.costReservedMinor)).toBeLessThanOrEqual(5n);
    expect(detail.coverageWarnings.map((w) => w.kind)).toContain("budget_capped");
    // Baseline evidence still publishes exactly.
    const byKind = new Map(detail.findings.map((f) => [f.kind, f]));
    expect(byKind.get("spending")!.amountMinor).toBe("40000");
    expect(byKind.get("income")!.amountMinor).toBe("120000");
  });

  it("denies cross-tenant analysis uniformly and reads zero rows unscoped", async () => {
    const base = await startApp();
    const setupA = await setupWorkspace(base, "deep-tenant-a", "tenanta");
    const checking = await seedAccount(setupA.claims, "Checking");
    await seedTransactions(setupA.claims, [{ accountId: checking, amountMinor: "10000", direction: "INFLOW", date: "2026-01-15", desc: "Pay" }]);
    await scoped(setupA.claims, (client) => maybeTriggerDeepAnalysisTx(client, setupA.workspaceId, setupA.userId, randomUUID()));
    expect(await runAnalysis(setupA.claims, scriptTransport([checking]))).toBe("applied");

    const setupB = await setupWorkspace(base, "deep-tenant-b", "tenantb");
    for (const [method, url, body] of [
      ["GET", `${base}/api/analysis/status?workspaceId=${setupA.workspaceId}`, undefined],
      ["GET", `${base}/api/analysis/detail?workspaceId=${setupA.workspaceId}`, undefined],
      ["POST", `${base}/api/analysis/stop`, { workspaceId: setupA.workspaceId }],
      ["POST", `${base}/api/analysis/retry`, { workspaceId: setupA.workspaceId }],
    ] as const) {
      const res = await call(method, url, setupB.cookie, body);
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ error: "not_found" });
    }
    await expect(readAnalysisStatus(pool, { userId: setupB.userId, workspaceId: setupA.workspaceId })).rejects.toBeInstanceOf(Error);
    const page = await fetch(`${base}/w/${setupA.workspaceId}/analysis`, { headers: { cookie: setupB.cookie, accept: "text/html" } });
    expect(page.status).toBe(404);
    // Unscoped reads fail closed to zero rows (NULLIF guard, never 22P02).
    const bare = await pool.connect();
    try {
      for (const table of ["deep_analysis_runs", "deep_analysis_steps", "deep_analysis_findings"]) {
        const r = await bare.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect((r.rows[0] as { n: number }).n).toBe(0);
      }
    } finally {
      bare.release();
    }
    // Retry on a terminal success is a conflict, not a second run.
    await expect(retryAnalysis(pool, setupA.claims, setupA.userId)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(stopAnalysis(pool, setupA.claims)).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("validates findings purely: unsupported numbers never publish", () => {
    const base = {
      summary: { baseCurrency: "EUR", incomeMinor: "100", spendMinor: "60", coverage: "full", evidenceRefs: ["calculation:3:abababababababab"] },
      recurringCount: 0,
      recurringEvidence: [],
      goals: [],
      projection: null,
      warnings: [],
      narrative: null,
    };
    const drafts = buildFindings(base);
    expect(drafts.map((d) => d.kind)).toEqual(["spending", "income"]);
    // Amount without evidence is dropped; foreign account refs are dropped.
    const doctored = [
      ...drafts.map((d) => ({ ...d, evidence: [] })),
      { kind: "spending" as const, title: "Sneaky", body: "x", amountMinor: "999", currency: "EUR", evidence: ["account:00000000-0000-0000-0000-000000000000"] },
    ];
    expect(validateFindings(doctored, new Set())).toHaveLength(0);
    expect(validateFindings(drafts, new Set())).toHaveLength(2);
  });

  it("rolls back and re-applies migration 038 on the suite database", async () => {
    const { readFileSync } = await import("node:fs");
    const rollbackSql = readFileSync("apps/web/migrations/038_deep_analysis.rollback.sql", "utf8");
    // Rollback procedure (migration header): restoring the narrower job
    // allowlist while deep-analysis.run rows exist must refuse — the suite
    // proves the CHECK violation fires before draining history.
    const admin = await pool.connect();
    try {
      await admin.query("BEGIN");
      await expect(admin.query(rollbackSql)).rejects.toThrow();
      await admin.query("ROLLBACK");
    } finally {
      admin.release();
    }
    // Drain history first (cancel/drain attempts, then revert), then roll back.
    await pool.query(`TRUNCATE deep_analysis_findings, deep_analysis_steps, deep_analysis_runs, background_job_attempts,
      job_dispatch_index, outbox_events, background_job_results, background_jobs, command_operations CASCADE`);
    const admin2 = await pool.connect();
    try {
      await admin2.query("BEGIN");
      await admin2.query(rollbackSql);
      await admin2.query("COMMIT");
    } catch (err) {
      try {
        await admin2.query("ROLLBACK");
      } catch { /* preserve */ }
      throw err;
    } finally {
      admin2.release();
    }
    const gone = await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('deep_analysis_runs', 'deep_analysis_steps', 'deep_analysis_findings')");
    expect((gone.rows[0] as { n: number }).n).toBe(0);
    const check = await pool.query("SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'background_jobs_type'");
    expect((check.rows[0] as { def: string }).def).not.toContain("deep-analysis.run");
    // Revert the additive migration only (001-037 effects are untouched):
    // re-record nothing, just re-apply 038 through the idempotent migrator.
    await pool.query("DELETE FROM schema_migrations WHERE version = '038_deep_analysis'");
    expect(await migrate(pool, "apps/web/migrations")).toEqual(["038_deep_analysis"]);
    const back = await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('deep_analysis_runs', 'deep_analysis_steps', 'deep_analysis_findings')");
    expect((back.rows[0] as { n: number }).n).toBe(3);
    const restored = await pool.query("SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'background_jobs_type'");
    expect((restored.rows[0] as { def: string }).def).toContain("deep-analysis.run");
  });
});
