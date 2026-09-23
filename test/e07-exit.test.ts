// E07-S05 complete core-loop exit: one browser/system journey over the merged
// E07 tree with synthetic accounts, exact-money oracles and browser evidence.
//
// Journey (single workspace `jx`, plus isolated stop/retry workspaces):
// sign in -> two-file batch upload with automatic (deduced, model-free)
// mapping -> accept -> immediately useful partial Home (before analysis
// completes) -> bounded validated Deep Analysis -> grounded chat answer ->
// artifact build -> failed edit retained + successful manual edit ->
// pin/reorder/resize -> reopen (layout + artifact state preserved) ->
// second overlapping import -> same artifact's live SDK data refresh with
// zero AI rerun and no stale grant. Stop/retry + provider-unavailable
// branches run on isolated workspaces. Chromium + Firefox 320px keyboard
// journeys; WebKit best-effort (recorded, never counted as pass).
//
// Frozen oracles (hand-computed, decimal-string minor units, current-month
// dates so Home's This-month section is meaningful):
// - file1 (Salary +2000.00 in; Rent -800.00, Groceries -45.50, Dining -65.00
//   out): inflow 200000, outflow 80000+4550+6500 = 91050.
// - file2 (Interest +150.00 in; Transit -12.25 out): inflow 215000,
//   outflow 91050+1225 = 92275; batch transactions 6, links NEW 6.
// - spending groups (batch): 215000+92275 = 307275, coverage partial
//   (vault excluded, excludedAccounts 1).
// - file3 (Rent overlap -800.00 MATCHED; Bonus +300.00 NEW): transactions 7,
//   inflow 245000, outflow 92275; refreshed groups 245000+92275 = 337275.
// - sentinel: one manual OUTFLOW 999.99 (minor 99999) in the excluded vault;
//   present in storage, never in findings/chat/artifact/SDK totals.
// Real disposable PostgreSQL (`moneo_e07_exit`, fails closed without PG) +
// real ingestion prerequisites (MinIO/ClamAV on loopback, disposable Redis
// DB 12, loopback-guarded; only DB 12 is ever flushed); deterministic
// scripted transports only - no live model, no customer data.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { Queue } from "bullmq";
import { chromium, firefox, webkit } from "@playwright/test";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import type { Session } from "../apps/web/src/session-store.ts";
import { createTenancyRouter, withTenant, type TenantClaims } from "../apps/web/src/tenancy.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
import { setAccountExclusion } from "../apps/web/src/ai-policy.ts";
import type { DispatchTransport } from "../apps/web/src/ai-dispatch.ts";
import {
  processDeepAnalysisJob,
  readAnalysisDetail,
  readAnalysisStatus,
  retryAnalysis,
  stopAnalysis,
} from "../apps/web/src/deep-analysis.ts";
import { createThread, getThread, processChatJob, readActivity, sendTurn } from "../apps/web/src/chat.ts";
import { runArtifactAiFlow } from "../apps/web/src/artifact-ai.ts";
import { issuePermit } from "../apps/web/src/ai-policy.ts";
import { getArtifact } from "../apps/web/src/commands/artifacts.ts";
import { getArtifactState, patchArtifactState } from "../apps/web/src/commands/artifact-state.ts";
import { moveTile, pinTile, resizeTile, readHomeLayout } from "../apps/web/src/commands/home-layout.ts";
import { TxError } from "../apps/web/src/commands/transactions.ts";
import {
  getSpendingByCategory,
  getTransactionSummary,
} from "../apps/web/src/calculations/financial-summary.ts";
import { dispatchOutbox, jobsQueue, type JobPayload } from "../apps/web/src/jobs.ts";
import { loadUploadConfig, processParseJob, type UploadConfig } from "../apps/web/src/uploads.ts";
import { s3EnsureBucket } from "../apps/web/src/s3.ts";
import { clamdPing } from "../apps/web/src/clamav.ts";
import { acceptImportCommitJob, processCommitJob, DEFAULT_COMMIT_CONFIG } from "../apps/web/src/import-commit.ts";
import { acceptMapping, proposeMapping } from "../apps/web/src/mapping.ts";
import { ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
let queue: Queue<JobPayload>;
let uploadConfig: UploadConfig;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
const tag = randomBytes(4).toString("hex");
const savedEnv: Record<string, string | undefined> = {};
const t0 = Date.now();
let webkitOk = false;
// Repair ledger: every failure below is repaired inside the journey.
let failuresObserved = 0;
let repairsObserved = 0;
let tHomeMs = -1;
let tFirstToolMs = -1;

const SENTINEL = "EXCLUDED-SENTINEL-77";

function ym(): { prefix: string; d: (day: number) => string } {
  const now = new Date();
  const prefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return { prefix, d: (day: number): string => `${prefix}-${String(day).padStart(2, "0")}` };
}
const D = ym();
const FILE1_CSV = [
  "date,description,amount",
  `${D.d(5)},Salary October,2000.00`,
  `${D.d(6)},Rent October,-800.00`,
  `${D.d(7)},Groceries,-45.50`,
  `${D.d(8)},Dining,-65.00`,
  "",
].join("\n");
const FILE2_CSV = [
  "date,description,amount",
  `${D.d(9)},Interest,150.00`,
  `${D.d(10)},Transit,-12.25`,
  "",
].join("\n");
const FILE3_CSV = [
  "date,description,amount",
  `${D.d(6)},Rent October,-800.00`,
  `${D.d(11)},Bonus,300.00`,
  "",
].join("\n");
const CSV_PROFILE = {
  delimiter: ",",
  dateFormat: "iso",
  amount: { kind: "signed", decimalSep: ".", thousandsSep: "," },
  columns: { date: "date", description: "description", amount: "amount" },
  defaultCurrency: "EUR",
};

const MANIFEST_BASE = {
  artifactSdkVersion: "1",
  runtimeVersion: "1",
  sourceSchemaVersion: "1",
  stateSchemaVersion: "1",
  requestedPermissions: ["analytics.spending_by_category"],
  approvedPermissions: ["analytics.spending_by_category"],
  entrypoints: { full: "main", compact: "compact" },
  resourceBudget: { maxMessagesPerSecond: 100 },
  sourceHash: "",
  buildHash: "",
};
const CHART_SOURCE = {
  html: '<section><h1>Exit loop chart</h1><div data-slot="chart"></div></section>',
  css: "section{font:16px system-ui;padding:1rem}",
  js: 'artifact.ui.render({ type: "chart", rows: [] });',
  manifest: { ...MANIFEST_BASE },
};
const CHART_EDITED = {
  ...CHART_SOURCE,
  html: '<section><h1>Exit loop chart (edited)</h1><div data-slot="chart"></div></section>',
};
const NOTES_SOURCE = {
  html: '<section><h1>Exit loop notes</h1><div data-slot="notes"></div></section>',
  css: "section{font:16px system-ui;padding:1rem}",
  js: 'artifact.ui.render({ type: "chart", rows: [] });',
  manifest: { ...MANIFEST_BASE },
};

function exitRedisUrl(): string {
  const base = env("E07-S05", "REDIS_URL");
  const u = new URL(base);
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("E07-S05 refused: REDIS_URL must point at the local disposable Redis.");
  }
  const db = process.env["E07_EXIT_REDIS_DB"] ?? "12";
  if (!/^\d+$/.test(db) || Number(db) < 1 || Number(db) > 15) throw new Error("E07-S05 misconfigured: E07_EXIT_REDIS_DB must be 1-15.");
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
  const uiConfig = { appBaseUrl: "http://127.0.0.1:1", sessionSecret };
  const resolve = (req: import("node:http").IncomingMessage): Promise<Session | null> =>
    requestSession(pool, sessionSecret, req);
  const server = createApp(createAuthRouter(config, pool), createTenancyRouter(pool, resolve), {
    ui: createUiRouter(pool, resolve, uiConfig),
  });
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

async function postForm(base: string, path: string, cookie: string, body: Record<string, string>): Promise<{ status: number; text: string; location: string | null }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, origin: base, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  });
  return { status: res.status, text: await res.text(), location: res.headers.get("location") };
}

async function getHtml(base: string, path: string, cookie: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  return { status: res.status, text: await res.text() };
}

function multipartBody(fields: Record<string, string>, file: { field: string; filename: string; contentType: string; bytes: Uint8Array }): { body: Uint8Array; contentType: string } {
  const boundary = `----moneo${randomBytes(8).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`, "utf8"));
  parts.push(Buffer.from(file.bytes));
  parts.push(Buffer.from("\r\n", "utf8"));
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: new Uint8Array(Buffer.concat(parts)), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Full upload->parse->map->commit pipeline (same legs E02 proves); asserts
// ordinary mapping needs no compulsory manual step: the deduced proposal
// (model-free) accepts directly with zero review decisions.
async function commitCsvImport(base: string, cookie: string, claims: TenantClaims, userId: string, accountId: string, filename: string, csv: string): Promise<{ transactions: number; links: Record<string, number> }> {
  const built = multipartBody(
    { idempotencyKey: randomUUID(), profile: JSON.stringify(CSV_PROFILE) },
    { field: "file", filename, contentType: "application/octet-stream", bytes: new TextEncoder().encode(csv) },
  );
  const upload = await fetch(`${base}/api/workspaces/${claims.workspaceId}/uploads`, {
    method: "POST",
    headers: { cookie, "Content-Type": built.contentType },
    body: new Blob([built.body as Uint8Array<ArrayBuffer>]),
  });
  if (upload.status !== 201) throw new Error(`upload failed with ${upload.status}: ${(await upload.text()).slice(0, 200)}`);
  const uploaded = (await upload.json()) as { import: { id: string }; jobId: string };
  await dispatchOutbox(pool, queue);
  if ((await processParseJob(pool, uploaded.jobId, uploadConfig)) !== "applied") throw new Error("staging failed");
  const proposed = await proposeMapping(pool, claims, uploaded.import.id, { transport: null });
  expect(proposed.aiUsed).toBe(false);
  await acceptMapping(pool, claims, uploaded.import.id, { proposalId: proposed.proposal.id, accountId });
  const reviews = await withTenant(pool, claims, async (client: PoolClient) =>
    client.query(
      "SELECT count(*)::int AS n FROM review_decisions d JOIN source_links l ON l.workspace_id = d.workspace_id AND l.id = d.source_link_id WHERE d.workspace_id = $1 AND l.import_id = $2",
      [claims.workspaceId, uploaded.import.id],
    ),
  );
  expect(Number((reviews.rows[0] as { n: number }).n)).toBe(0);
  const commit = await acceptImportCommitJob(pool, claims, userId, { workspaceId: claims.workspaceId, idempotencyKey: randomUUID(), importId: uploaded.import.id, accountId });
  await dispatchOutbox(pool, queue);
  if ((await processCommitJob(pool, commit.jobId, DEFAULT_COMMIT_CONFIG)) !== "applied") throw new Error("commit failed");
  return withTenant(pool, claims, async (client: PoolClient) => {
    const tx = await client.query("SELECT count(*)::int AS n FROM transactions WHERE workspace_id = $1", [claims.workspaceId]);
    const links = await client.query("SELECT status, count(*)::int AS n FROM source_links WHERE workspace_id = $1 GROUP BY status", [claims.workspaceId]);
    return {
      transactions: (tx.rows[0] as { n: number }).n,
      links: Object.fromEntries(links.rows.map((r) => [(r as { status: string }).status, (r as { n: number }).n])),
    };
  });
}

async function analysisJobId(claims: TenantClaims): Promise<string | null> {
  return withTenant(pool, claims, async (client: PoolClient) => {
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

// Deterministic scripted analysis transport: one finance.totals evidence
// call over the eligible checking account, then a short analyst note.
function scriptAnalysisTransport(checking: string): DispatchTransport {
  let n = 0;
  return async () => {
    n += 1;
    if (n === 1) {
      return {
        httpStatus: 200,
        bodyText: JSON.stringify({ tool_calls: [{ name: "finance.totals", args: { accountIds: [checking] } }] }),
        inputTokens: 100,
        outputTokens: 50,
        model: "e07-exit-fake",
      };
    }
    return {
      httpStatus: 200,
      bodyText: JSON.stringify({ final: "Steady household: salary covers rent and daily spend with margin." }),
      inputTokens: 100,
      outputTokens: 30,
      model: "e07-exit-fake",
    };
  };
}

const failAnalysisTransport: DispatchTransport = async () => ({
  httpStatus: null,
  bodyText: null,
  inputTokens: null,
  outputTokens: null,
  model: "e07-exit-fake",
});

function chatTransport(text: string, calls: { count: number }): DispatchTransport {
  return async () => {
    calls.count += 1;
    return { httpStatus: 200, bodyText: text, inputTokens: 50, outputTokens: 25, model: "e07-exit-fake" };
  };
}

async function usageLedger(claims: TenantClaims): Promise<{ n: number; input: string; output: string; cost: string }> {
  return withTenant(pool, claims, async (client: PoolClient) => {
    const r = await client.query(
      "SELECT count(*)::int AS n, COALESCE(SUM(input_tokens), 0)::text AS input, COALESCE(SUM(output_tokens), 0)::text AS output, COALESCE(SUM(reconciled_cost_minor::bigint), 0)::text AS cost FROM ai_dispatch_usage WHERE workspace_id = $1",
      [claims.workspaceId],
    );
    return r.rows[0] as { n: number; input: string; output: string; cost: string };
  });
}

async function dataRevision(claims: TenantClaims): Promise<string> {
  return withTenant(pool, claims, async (client: PoolClient) => {
    const r = await client.query("SELECT revision AS r FROM workspace_data_revision WHERE workspace_id = $1", [claims.workspaceId]);
    return (r.rowCount ?? 0) === 0 ? "none" : String((r.rows[0] as { r: string }).r);
  });
}

// Shared journey context: it1 builds it, later its extend it (explicit order).
let jx: {
  base: string; cookie: string; workspaceId: string; userId: string; claims: TenantClaims;
  checking: string; vault: string; artifactId: string; notesId: string; v1: string; v2: string;
  sessionId: string;
} | undefined;

beforeAll(async () => {
  process.env["APP_ENV"] = "test";
  for (const name of ["UPLOADS_ENABLED", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET", "CLAMAV_HOST", "CLAMAV_PORT", "PARSER_CHILD"]) {
    savedEnv[name] = process.env[name];
  }
  pool = await ensureTestPool("E07-S05", "moneo_e07_exit", [
    "notices",
    "home_layout_tiles",
    "home_layouts",
    "deep_analysis_findings",
    "deep_analysis_steps",
    "deep_analysis_runs",
    "artifact_ai_proposals",
    "artifact_state_migrations",
    "artifact_state_snapshots",
    "artifact_state",
    "artifact_sdk_access_events",
    "artifact_runtime_grants",
    "artifact_build_attempts",
    "artifact_versions",
    "artifacts",
    "scenario_overrides",
    "scenarios",
    "projection_runs",
    "projection_points",
    "projection_events",
    "projection_settings",
    "chat_tool_calls",
    "chat_activity",
    "chat_attempts",
    "chat_turns",
    "chat_threads",
    "ai_dispatch_usage",
    "ai_dispatch_reservations",
    "ai_dispatch_budgets",
    "ai_dispatch_permits",
    "ai_exclusions",
    "ai_policies",
    "financial_assumptions",
    "goals",
    "goal_allocations",
    "recurring_overrides",
    "transaction_tags",
    "audit_events",
    "tags",
    "categories",
    "workspace_data_revision",
    "calculation_versions",
    "fx_valuation",
    "fx_rates_ecb",
    "fx_rates_manual",
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
    "command_operations",
    "accounts",
    "workspace_members",
    "workspaces",
    "users",
    "app_sessions",
  ]);
  stub = await startStubIssuer();
  process.env["UPLOADS_ENABLED"] = "1";
  if (!process.env["S3_ENDPOINT"]) process.env["S3_ENDPOINT"] = "http://127.0.0.1:9000";
  if (!process.env["S3_REGION"]) process.env["S3_REGION"] = "us-east-1";
  for (const name of ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"]) {
    if (!process.env[name]) process.env[name] = env("E07-S05", name);
  }
  if (!process.env["CLAMAV_HOST"]) process.env["CLAMAV_HOST"] = "127.0.0.1";
  if (!process.env["CLAMAV_PORT"]) process.env["CLAMAV_PORT"] = "3310";
  uploadConfig = loadUploadConfig();
  await s3EnsureBucket(uploadConfig.s3);
  if (!(await clamdPing(uploadConfig.clamav))) throw new Error("E07-S05 prerequisite missing: clamd unreachable.");
  const { existsSync } = await import("node:fs");
  if (!existsSync(uploadConfig.parserChild)) throw new Error(`E07-S05 prerequisite missing: parser child not built at ${uploadConfig.parserChild}.`);
  const url = exitRedisUrl();
  queue = jobsQueue(url);
  await queue.waitUntilReady();
  await queue.obliterate({ force: true });
  try {
    const probe = await webkit.launch({ headless: true });
    await probe.close();
    webkitOk = true;
  } catch (err) {
    // Best-effort only: recorded honestly, never counted as pass.
    // eslint-disable-next-line no-console
    console.log(`[e07-exit] webkit unavailable on this host: ${(err as Error).message}`);
    webkitOk = false;
  }
}, 180_000);

afterAll(async () => {
  const usage = jx ? await usageLedger(jx.claims).catch(() => null) : null;
  // eslint-disable-next-line no-console
  console.log(`[e07-exit] summary elapsed=${Date.now() - t0}ms firstHome=${tHomeMs}ms firstTool=${tFirstToolMs}ms failures=${failuresObserved} repairs=${repairsObserved} usage=${usage ? JSON.stringify(usage) : "n/a"} webkit=${webkitOk ? "ran" : "unavailable"}`);
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (queue) await queue.close();
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e07-s05 exit: sign in, batch import, trusted Home before analysis", () => {
  it("two-file batch uploads map automatically and Home is useful before the model completes", async () => {
    const base = await startApp();
    const cookie = await login(base, `synthetic-e07-exit-${tag}`);
    const wsRes = await postJson(base, "/api/workspaces", cookie, { name: `Exit Loop ${tag}`, baseCurrency: "EUR" });
    expect(wsRes.status).toBe(201);
    const workspaceId = (wsRes.json as { id: string }).id;
    const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [`synthetic-e07-exit-${tag}`])).rows[0] as { id: string }).id;
    const claims: TenantClaims = { userId, workspaceId };
    const mkAccount = async (name: string): Promise<string> => {
      const res = await postJson(base, "/api/commands/accounts.create", cookie, { workspaceId, name, currency: "EUR", idempotencyKey: randomUUID() });
      expect(res.status).toBe(200);
      return (res.json as { id: string }).id;
    };
    const checking = await mkAccount(`Exit Checking ${tag}`);
    const vault = await mkAccount(`Exit Vault ${tag}`);
    await setAccountExclusion(pool, claims, userId, vault, true, "synthetic");
    // Unique excluded-data sentinel: stored honestly, must never publish.
    const sentinel = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId, accountId: vault, amount: "999.99", currency: "EUR", direction: "OUTFLOW",
      effectiveDate: D.d(4), description: `${SENTINEL} stash`, idempotencyKey: randomUUID(),
    });
    expect(sentinel.status).toBe(200);

    const batch1 = await commitCsvImport(base, cookie, claims, userId, checking, "batch-1.csv", FILE1_CSV);
    expect(batch1.transactions).toBe(4);
    expect(batch1.links).toEqual({ NEW: 4 });
    const batch2 = await commitCsvImport(base, cookie, claims, userId, checking, "batch-2.csv", FILE2_CSV);
    expect(batch2.transactions).toBe(6);
    expect(batch2.links).toEqual({ NEW: 6 });

    // Independent oracle: 215000 inflow, 92275 outflow, 6 rows + sentinel.
    const spending = await getSpendingByCategory(pool, claims, {});
    expect(spending.coverage).toBe("partial");
    expect(spending.excludedAccounts).toBe(1);
    expect(spending.groups).toEqual([{ label: "Uncategorized", amount: "307275" }]);
    const summary = await getTransactionSummary(pool, claims, {});
    // Shared queries exclude the vault by design: 6 import rows visible.
    expect(summary.rows).toHaveLength(6);
    expect(summary.rows.filter((r) => r.description === "Rent October")).toHaveLength(1);
    expect(summary.rows.some((r) => r.description.includes(SENTINEL))).toBe(false);
    // The sentinel is stored honestly in canonical storage, only hidden
    // from AI/shared views.
    const stored = await withTenant(pool, claims, async (client: PoolClient) =>
      client.query("SELECT count(*)::int AS n FROM manual_transactions WHERE workspace_id = $1 AND description LIKE '%' || $2 || '%'", [workspaceId, SENTINEL]),
    );
    expect(Number((stored.rows[0] as { n: number }).n)).toBe(1);

    // Home BEFORE the model completes: trusted metrics + progress, no blank
    // dashboard, sentinel never rendered.
    const home = await getHtml(base, `/w/${workspaceId}/home`, cookie);
    expect(home.status).toBe(200);
    tHomeMs = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[e07-exit] first trusted Home at ${tHomeMs}ms`);
    expect(home.text).toContain("Available to Spend");
    expect(home.text).toContain("Deep Analysis");
    expect(home.text).toContain("QUEUED");
    expect(home.text).toContain("Stop analysis");
    expect(home.text).toContain("215000");
    // Owner's This-month view is complete: eligible 92275 + the owner's own
    // vault 99999 = 192274. AI surfaces (findings/chat/SDK) must exclude the
    // vault and report 92275; those legs assert that below.
    expect(home.text).toContain("192274");
    // No snapshots exist, so forward cushion is honestly unavailable.
    expect(home.text).toContain("UNAVAILABLE");
    expect(home.text).toContain("missing_balance");
    expect(home.text).not.toContain(SENTINEL);
    expect(home.text).not.toContain("No Deep Analysis yet");
    expect(home.text).not.toContain("<script");

    // One initial analysis coalesced both commits (batch window, one run).
    const runs = await withTenant(pool, claims, async (client: PoolClient) =>
      client.query("SELECT status, commit_ids FROM deep_analysis_runs WHERE workspace_id = $1", [workspaceId]),
    );
    expect(runs.rowCount).toBe(1);
    expect((runs.rows[0] as { status: string }).status).toBe("QUEUED");
    expect(((runs.rows[0] as { commit_ids: string[] }).commit_ids)).toHaveLength(2);

    jx = { base, cookie, workspaceId, userId, claims, checking, vault, artifactId: "", notesId: "", v1: "", v2: "", sessionId: "" };
  }, 120_000);
});

describe("e07-s05 exit: bounded validated Deep Analysis", () => {
  it("analysis succeeds with exact-money findings; sentinel and unsupported findings never publish", async () => {
    if (!jx) throw new Error("journey context missing: leg 1 must run first");
    const outcome = await runAnalysis(jx.claims, scriptAnalysisTransport(jx.checking));
    expect(outcome).toBe("applied");
    const status = await readAnalysisStatus(pool, jx.claims);
    expect(status).toMatchObject({ status: "SUCCEEDED" });
    const detail = await readAnalysisDetail(pool, jx.claims);
    expect(detail).not.toBeNull();
    const findings = detail!.findings;
    const byKind = new Map(findings.map((f) => [f.kind, f]));
    // Hand-computed oracles from the frozen batch fixtures.
    expect(byKind.get("spending")).toMatchObject({ amountMinor: "92275", currency: "EUR" });
    expect(byKind.get("income")).toMatchObject({ amountMinor: "215000", currency: "EUR" });
    for (const f of findings) {
      // Evidence gate semantics: amount-bearing findings need evidence;
      // the coverage warning honestly carries none.
      if (f.amountMinor !== null) expect(f.evidence.length).toBeGreaterThan(0);
      const blob = `${f.title} ${f.body} ${f.amountMinor ?? ""} ${f.evidence.join(" ")}`;
      expect(blob).not.toContain(SENTINEL);
      expect(blob).not.toContain(jx.vault);
    }
    // Coverage warning names the excluded account gap honestly.
    expect(findings.some((f) => f.kind === "coverage")).toBe(true);
    const home = await getHtml(jx.base, `/w/${jx.workspaceId}/home`, jx.cookie);
    expect(home.status).toBe(200);
    expect(home.text).toContain("SUCCEEDED");
    expect(home.text).toContain("Observed spending");
    expect(home.text).toContain("Observed income");
    expect(home.text).not.toContain(SENTINEL);
    const usage = await usageLedger(jx.claims);
    expect(usage.n).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line no-console
    console.log(`[e07-exit] analysis usage dispatches=${usage.n} input=${usage.input} output=${usage.output} cost=${usage.cost}`);
  }, 120_000);
});

describe("e07-s05 exit: Stop fences late results; provider outage fails then retry repairs", () => {
  it("Stop before the worker fences publication; retry on the same run succeeds", async () => {
    if (!jx) throw new Error("journey context missing: leg 1 must run first");
    const base = jx.base;
    const cookie = await login(base, `synthetic-e07-stop-${tag}`);
    const wsRes = await postJson(base, "/api/workspaces", cookie, { name: `Exit Stop ${tag}`, baseCurrency: "EUR" });
    const workspaceId = (wsRes.json as { id: string }).id;
    const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [`synthetic-e07-stop-${tag}`])).rows[0] as { id: string }).id;
    const claims: TenantClaims = { userId, workspaceId };
    const acct = (await postJson(base, "/api/commands/accounts.create", cookie, { workspaceId, name: `Stop Cash ${tag}`, currency: "EUR", idempotencyKey: randomUUID() })).json as { id: string };
    await commitCsvImport(base, cookie, claims, userId, acct.id, "stop.csv", `date,description,amount\n${D.d(5)},Pay,100.00\n`);
    const stopped = await stopAnalysis(pool, claims);
    expect(stopped.status).toBe("CANCELLED");
    failuresObserved += 1;
    const outcome = await runAnalysis(claims, scriptAnalysisTransport(acct.id));
    expect(outcome).toBe("duplicate-terminal-noop");
    const detail = await readAnalysisDetail(pool, claims);
    expect(detail!.status).toBe("CANCELLED");
    expect(detail!.findings).toHaveLength(0);
    const retried = await retryAnalysis(pool, claims, userId);
    expect(["QUEUED", "RUNNING"]).toContain(retried.status);
    expect(await runAnalysis(claims, scriptAnalysisTransport(acct.id))).toBe("applied");
    repairsObserved += 1;
    expect((await readAnalysisStatus(pool, claims))!.status).toBe("SUCCEEDED");
  }, 120_000);

  it("provider-unavailable fails the run without fabrication; retry repairs it", async () => {
    if (!jx) throw new Error("journey context missing: leg 1 must run first");
    const base = jx.base;
    const cookie = await login(base, `synthetic-e07-outage-${tag}`);
    const wsRes = await postJson(base, "/api/workspaces", cookie, { name: `Exit Outage ${tag}`, baseCurrency: "EUR" });
    const workspaceId = (wsRes.json as { id: string }).id;
    const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [`synthetic-e07-outage-${tag}`])).rows[0] as { id: string }).id;
    const claims: TenantClaims = { userId, workspaceId };
    const acct = (await postJson(base, "/api/commands/accounts.create", cookie, { workspaceId, name: `Outage Cash ${tag}`, currency: "EUR", idempotencyKey: randomUUID() })).json as { id: string };
    await commitCsvImport(base, cookie, claims, userId, acct.id, "outage.csv", `date,description,amount\n${D.d(5)},Pay,100.00\n`);
    expect(await runAnalysis(claims, failAnalysisTransport)).toBe("failed-final");
    failuresObserved += 1;
    const failed = await readAnalysisStatus(pool, claims);
    expect(failed!.status).toBe("FAILED_FINAL");
    expect((await readAnalysisDetail(pool, claims))!.findings).toHaveLength(0);
    await retryAnalysis(pool, claims, userId);
    expect(await runAnalysis(claims, scriptAnalysisTransport(acct.id))).toBe("applied");
    repairsObserved += 1;
    expect((await readAnalysisStatus(pool, claims))!.status).toBe("SUCCEEDED");
  }, 120_000);
});

describe("e07-s05 exit: grounded chat answer with evidence", () => {
  it("chat answers with exact oracle figures, an evidence link, and no sentinel", async () => {
    if (!jx) throw new Error("journey context missing: leg 1 must run first");
    const thread = await createThread(pool, jx.claims, jx.userId, { title: "Exit loop question" });
    const sent = await sendTurn(pool, jx.claims, jx.userId, { threadId: thread.id, body: "How much did I earn and spend this month?", idempotencyKey: randomUUID() });
    const calls = { count: 0 };
    const answer = `You earned 215000 minor EUR and spent 92275 minor EUR this month. See <a href="/w/${jx.workspaceId}/transactions">transactions</a>.`;
    const outcome = await processChatJob(pool, sent.jobId, chatTransport(answer, calls), { workerId: "e07-exit", leaseMs: 30_000 });
    expect(outcome).toBe("applied");
    expect(calls.count).toBe(1);
    const activity = await readActivity(pool, jx.claims, thread.id, 0, 100);
    expect(activity.events.some((e) => e.kind === "assistant-published")).toBe(true);
    const full = await getThread(pool, jx.claims, thread.id);
    const assistant = full!.turns.find((t) => t.role === "assistant");
    expect(assistant).toMatchObject({ status: "completed" });
    expect(assistant!.body).toContain("215000");
    expect(assistant!.body).toContain("92275");
    expect(assistant!.body).toContain("/transactions");
    expect(assistant!.body).not.toContain(SENTINEL);
    const page = await getHtml(jx.base, `/w/${jx.workspaceId}/chat/${thread.id}`, jx.cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain("215000");
    expect(page.text).not.toContain(SENTINEL);
  }, 120_000);
});

describe("e07-s05 exit: artifact build, failed edit, pin, reopen, live refresh", () => {
  it("manual publish, failed edit retained, successful edit, AI proposal without activation", async () => {
    if (!jx) throw new Error("journey context missing: leg 1 must run first");
    const { base, cookie, workspaceId, claims } = jx;
    const draft = await postJson(base, "/api/artifacts", cookie, { workspaceId, name: "Exit loop chart" });
    expect(draft.status).toBe(201);
    const artifactId = (draft.json as { artifactId: string }).artifactId;
    jx.artifactId = artifactId;
    const published = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookie, {
      html: CHART_SOURCE.html, css: CHART_SOURCE.css, js: CHART_SOURCE.js,
      manifest: JSON.stringify(CHART_SOURCE.manifest), expectedBaseVersionId: "", action: "publish",
    });
    expect(published.status).toBe(303);
    const list1 = (await (await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } })).json()) as {
      versions: Array<{ versionId: string; status: string }>;
    };
    expect(list1.versions).toHaveLength(1);
    const v1 = list1.versions[0]!.versionId;
    jx.v1 = v1;
    expect(list1.versions[0]!.status).toBe("ready");
    const act1 = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/activate`, cookie, { versionId: v1, expectedActiveVersionId: "" });
    expect(act1.status).toBe(303);
    tFirstToolMs = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[e07-exit] first saved tool (artifact v1 active) at ${tFirstToolMs}ms`);

    // Failed edit: hostile network call is recorded failed, active kept.
    failuresObserved += 1;
    const bad = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookie, {
      html: CHART_SOURCE.html, css: CHART_SOURCE.css, js: 'fetch("https://evil.invalid");',
      manifest: JSON.stringify(CHART_SOURCE.manifest), expectedBaseVersionId: v1, action: "publish",
    });
    expect(bad.status).toBe(303);
    expect(bad.location).toContain("notice=failed");
    const versions = (await (await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } })).json()) as {
      versions: Array<{ versionId: string; status: string }>;
    };
    expect(versions.versions.some((v) => v.status === "failed")).toBe(true);
    const art = await withTenant(pool, claims, (client: PoolClient) => getArtifact(client, claims, artifactId));
    expect(art?.activeVersionId).toBe(v1);
    repairsObserved += 1;

    // Successful manual edit on the same artifact, based on the latest
    // version (the failed attempt advanced the tip, so v1 is stale).
    const tip = (await (await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } })).json()) as {
      versions: Array<{ versionId: string; status: string }>;
    };
    const failedTip = tip.versions.find((v) => v.status === "failed")!.versionId;
    const edited = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookie, {
      html: CHART_EDITED.html, css: CHART_EDITED.css, js: CHART_EDITED.js,
      manifest: JSON.stringify(CHART_EDITED.manifest), expectedBaseVersionId: failedTip, action: "publish",
    });
    expect(edited.status).toBe(303);
    const list2 = (await (await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } })).json()) as {
      versions: Array<{ versionId: string; status: string }>;
    };
    const v2 = list2.versions.find((v) => v.versionId !== v1 && v.status === "ready")!.versionId;
    jx.v2 = v2;
    const act2 = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/activate`, cookie, { versionId: v2, expectedActiveVersionId: v1 });
    expect(act2.status).toBe(303);

    // AI edit targets the SAME artifact and stays inactive until published.
    const thread = await createThread(pool, claims, jx.userId, { title: "Exit loop AI edit" });
    const permit = await issuePermit(pool, claims, "artifact-builder");
    const scripted = async (): Promise<{ httpStatus: number; bodyText: string; inputTokens: number; outputTokens: number; model: string }> => ({
      httpStatus: 200, bodyText: JSON.stringify(NOTES_SOURCE), inputTokens: 10, outputTokens: 5, model: "e07-exit-fake",
    });
    const ai = await runArtifactAiFlow(pool, claims, jx.userId, {
      kind: "edit", artifactId, baseVersionId: v2, instruction: "Add a notes panel.",
      idempotencyKey: randomUUID(), permitId: permit.id, threadId: thread.id,
    }, scripted);
    if (!ai.ok) throw new Error(`AI edit failed: ${ai.errorClass}`);
    const stillManual = await withTenant(pool, claims, (client: PoolClient) => getArtifact(client, claims, artifactId));
    expect(stillManual?.activeVersionId).toBe(v2);
  }, 120_000);

  it("pin, CAS conflict retry, reorder, resize; reopen preserves layout and artifact state", async () => {
    if (!jx || !jx.artifactId) throw new Error("journey context missing: artifact leg must run first");
    const { base, cookie, workspaceId, userId, claims, artifactId } = jx;
    const notes = await postJson(base, "/api/artifacts", cookie, { workspaceId, name: "Exit loop notes" });
    expect(notes.status).toBe(201);
    const notesId = (notes.json as { artifactId: string }).artifactId;
    jx.notesId = notesId;
    await postForm(base, `/w/${workspaceId}/artifacts/${notesId}/versions`, cookie, {
      html: NOTES_SOURCE.html, css: NOTES_SOURCE.css, js: NOTES_SOURCE.js,
      manifest: JSON.stringify(NOTES_SOURCE.manifest), expectedBaseVersionId: "", action: "publish",
    });
    const notesVersion = ((await (await fetch(`${base}/api/artifacts/${notesId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } })).json()) as {
      versions: Array<{ versionId: string }>;
    }).versions[0]!.versionId;
    // Pins resolve the active version: activate before pinning.
    expect((await postForm(base, `/w/${workspaceId}/artifacts/${notesId}/activate`, cookie, { versionId: notesVersion, expectedActiveVersionId: "" })).status).toBe(303);
    const first = await pinTile(pool, claims, userId, { workspaceId, artifactId, size: "wide", expectedVersion: "1", idempotencyKey: randomUUID() });
    expect(first.view.version).toBe("2");
    expect(first.view.tiles).toHaveLength(1);
    // Stale pin from version 1 conflicts; retry from the fresh version
    // preserves both intents (failure + repair, no lost update).
    failuresObserved += 1;
    let conflictVersion = "2";
    try {
      await pinTile(pool, claims, userId, { workspaceId, artifactId: notesId, size: "small", expectedVersion: "1", idempotencyKey: randomUUID() });
      throw new Error("expected version_mismatch, but the stale pin succeeded");
    } catch (err) {
      expect(err).toBeInstanceOf(TxError);
      expect((err as TxError).code).toBe("version_mismatch");
      conflictVersion = String((err as TxError).currentVersion);
    }
    const retry = await pinTile(pool, claims, userId, { workspaceId, artifactId: notesId, size: "small", expectedVersion: conflictVersion, idempotencyKey: randomUUID() });
    expect(retry.view.version).toBe("3");
    expect(retry.view.tiles.map((t) => t.artifactId)).toEqual([artifactId, notesId]);
    repairsObserved += 1;
    const moved = await moveTile(pool, claims, userId, { workspaceId, artifactId: notesId, toPosition: "0", expectedVersion: retry.view.version, idempotencyKey: randomUUID() });
    const resized = await resizeTile(pool, claims, userId, { workspaceId, artifactId, size: "large", expectedVersion: moved.view.version, idempotencyKey: randomUUID() });
    expect(resized.view.tiles.map((t: { artifactId: string }) => t.artifactId)).toEqual([notesId, artifactId]);
    expect(resized.view.tiles.find((t: { artifactId: string }) => t.artifactId === artifactId)!.size).toBe("large");
    // Artifact state survives reopen.
    const patched = await withTenant(pool, claims, (client: PoolClient) =>
      patchArtifactState(client, claims, artifactId, [{ op: "add", path: "months", value: 6 }], 0),
    );
    expect(patched.state).toMatchObject({ months: 6 });
    const reopened = await withTenant(pool, claims, (client: PoolClient) => getArtifactState(client, claims, artifactId));
    expect(reopened!.state).toMatchObject({ months: 6 });
    // Reload: layout order + state persist, unauthorized pins absent.
    const home = await getHtml(base, `/w/${workspaceId}/home`, cookie);
    expect(home.status).toBe(200);
    expect(home.text.indexOf("Exit loop notes") < home.text.indexOf("Exit loop chart")).toBe(true);
    const view = await getHtml(base, `/w/${workspaceId}/artifacts/${artifactId}/versions/${jx.v2}/full`, cookie);
    expect(view.status).toBe(200);
    const sessionId = view.text.match(/sessionId:"([0-9a-f-]{36})"/)?.[1];
    expect(sessionId).toBeTruthy();
    jx.sessionId = sessionId!;
  }, 120_000);

  it("second overlapping import refreshes the live artifact with zero AI rerun and no stale grant", async () => {
    if (!jx || !jx.sessionId) throw new Error("journey context missing: reopen leg must run first");
    const { base, cookie, claims, userId, checking } = jx;
    const usageBefore = await usageLedger(claims);
    const revisionBefore = await dataRevision(claims);
    const batch3 = await commitCsvImport(base, cookie, claims, userId, checking, "batch-3.csv", FILE3_CSV);
    expect(batch3.transactions).toBe(7);
    expect(batch3.links["MATCHED"]).toBe(1);
    const refreshed = await getSpendingByCategory(pool, claims, {});
    expect(refreshed.groups).toEqual([{ label: "Uncategorized", amount: "337275" }]);
    const summary = await getTransactionSummary(pool, claims, {});
    expect(summary.rows).toHaveLength(7);
    expect(summary.rows.filter((r) => r.description === "Bonus")).toHaveLength(1);
    expect(summary.rows.filter((r) => r.description === "Rent October")).toHaveLength(1);
    expect(summary.rows.some((r) => r.description.includes(SENTINEL))).toBe(false);
    // Zero new AI usage across the refresh; open grant stays live.
    expect(await usageLedger(claims)).toEqual(usageBefore);
    expect(await dataRevision(claims)).toBe(revisionBefore);
    const rpcRes = await fetch(`${base}/api/artifacts/sdk/rpc`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: jx.sessionId, method: "spendingByCategory", args: {} }),
    });
    expect(rpcRes.status).toBe(200);
    const rpc = (await rpcRes.json()) as { result: { groups: { label: string; amount: string }[]; coverage: string } };
    expect(rpc.result.groups).toEqual([{ label: "Uncategorized", amount: "337275" }]);
    expect(rpc.result.coverage).toBe("partial");
  }, 120_000);
});

describe("e07-s05 exit: isolation, notices, keyboard/focus/error journey at 320px", () => {
  it("foreign references deny uniformly; completion notice appears exactly once", async () => {
    if (!jx || !jx.artifactId) throw new Error("journey context missing");
    const base = jx.base;
    const cookieB = await login(base, `synthetic-e07-foreign-${tag}`);
    const wsB = await postJson(base, "/api/workspaces", cookieB, { name: `Exit Foreign ${tag}`, baseCurrency: "EUR" });
    expect(wsB.status).toBe(201);
    const foreignHome = await getHtml(base, `/w/${jx.workspaceId}/home`, cookieB);
    expect(foreignHome.status).toBe(404);
    const foreignView = await getHtml(base, `/w/${jx.workspaceId}/artifacts/${jx.artifactId}/versions/${jx.v2}/full`, cookieB);
    expect(foreignView.status).toBe(404);
    const foreignRpc = await postJson(base, "/api/artifacts/sdk/rpc", cookieB, { sessionId: jx.sessionId, method: "spendingByCategory", args: {} });
    expect(foreignRpc.status).toBe(404);
    const first = await getHtml(base, `/w/${jx.workspaceId}/notices`, jx.cookie);
    expect(first.status).toBe(200);
    const second = await getHtml(base, `/w/${jx.workspaceId}/notices`, jx.cookie);
    expect(second.status).toBe(200);
    expect(second.text).toBe(first.text);
  }, 120_000);

  async function keyboardJourney(browserType: typeof chromium, label: string, linksTabbable = true): Promise<void> {
    if (!jx) throw new Error("journey context missing");
    const browser = await browserType.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 320, height: 720 }, reducedMotion: "reduce" });
      const equals = jx.cookie.indexOf("=");
      await context.addCookies([{ name: jx.cookie.slice(0, equals), value: jx.cookie.slice(equals + 1), url: jx.base }]);
      const pg = await context.newPage();
      await pg.goto(`${jx.base}/w/${jx.workspaceId}/home`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      expect(await pg.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      expect(await pg.content()).toContain("Available to Spend");
      expect(await pg.content()).not.toContain(SENTINEL);
      await pg.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Home" }).waitFor({ state: "visible", timeout: 5_000 });
      if (linksTabbable) {
        await pg.keyboard.press("Tab");
        expect(await pg.evaluate(() => (document.activeElement as HTMLElement).textContent)).toContain("Skip to main content");
        await pg.getByRole("link", { name: /Jump to/ }).focus();
        await Promise.all([pg.waitForURL(`**/w/${jx.workspaceId}/go`, { timeout: 5_000 }), pg.keyboard.press("Enter")]);
      } else {
        await pg.goto(`${jx.base}/w/${jx.workspaceId}/go`, { waitUntil: "domcontentloaded", timeout: 10_000 });
      }
      await pg.waitForFunction(() => (document.activeElement as HTMLElement).id === "palette-input", null, { timeout: 5_000 });
      await pg.keyboard.type("money");
      await pg.keyboard.press("Escape");
      expect(pg.url()).toContain(`/w/${jx.workspaceId}/go`);
      // Error journey: an unknown route fails with an honest error page.
      await pg.goto(`${jx.base}/w/${jx.workspaceId}/no-such-page-xyz`, { waitUntil: "domcontentloaded", timeout: 10_000 });
      expect(await pg.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      // Live artifact reopen keeps the saved state and offers Stop.
      await pg.goto(`${jx.base}/w/${jx.workspaceId}/artifacts/${jx.artifactId}/versions/${jx.v2}/full`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      expect(await pg.content()).toContain("art-stop");
      expect(await pg.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await pg.goto(`${jx.base}/w/${jx.workspaceId}/jobs`, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await pg.getByRole("status").first().waitFor({ state: "visible", timeout: 5_000 });
    } finally {
      await browser.close();
    }
  }

  it("Chromium 320px keyboard journey: Home totals, palette, Escape, error page, artifact Stop", async () => {
    await keyboardJourney(chromium, "chromium");
  }, 90_000);

  it("Firefox 320px keyboard journey: Home totals, palette, Escape, error page, artifact Stop", async () => {
    await keyboardJourney(firefox, "firefox");
  }, 90_000);

  it("WebKit 320px journey (best-effort)", async (ctx) => {
    if (!webkitOk) {
      ctx.skip();
      return;
    }
    await keyboardJourney(webkit, "webkit", false);
  }, 90_000);
});
