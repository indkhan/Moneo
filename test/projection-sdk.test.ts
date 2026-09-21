// E06-S04 artifact SDK "projection" (permission forecast.read) served at
// POST /api/artifacts/sdk/rpc. Real disposable PostgreSQL (own `moneo_e06_sdk`
// DB), stub issuer for auth. Synthetic finance/artifact data only.
//
// Contract notes (verified against apps/web/src/projections/engine.ts +
// apps/web/src/tenancy.ts; they override the looser task text):
// - runSdkProjection caps horizonDays at 120 (evaluateProjection allows 365),
//   so the 500-point truncation is driven with horizonDays 120 on 1 account
//   (120d x 3 cases x 2 scopes = 720 points); horizonDays 365 is rejected.
// - Malformed projection args throw TenantInvalid inside the shared RPC catch,
//   which answers 500 rpc_failed (same precedent as e05-exit.test.ts bad SDK
//   args) — the envelope alone 400s on invalid_request.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import type { Session } from "../apps/web/src/session-store.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { getArtifactSession } from "../apps/web/src/artifact-host.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
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

function form(body: Record<string, string>): { payload: string; headers: Record<string, string> } {
  return { payload: new URLSearchParams(body).toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" } };
}

async function postForm(base: string, path: string, cookie: string, body: Record<string, string>): Promise<{ status: number; text: string; location: string | null }> {
  const f = form(body);
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, origin: base, ...f.headers },
    body: f.payload,
    redirect: "manual",
  });
  return { status: res.status, text: await res.text(), location: res.headers.get("location") };
}

async function apiCreateDraft(base: string, cookie: string, workspaceId: string, name: string): Promise<string> {
  const res = await fetch(`${base}/api/artifacts`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, name }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { artifactId: string }).artifactId;
}

async function apiListVersions(base: string, cookie: string, workspaceId: string, artifactId: string): Promise<Array<{ versionId: string; status: string }>> {
  const res = await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { versions: Array<{ versionId: string; status: string }> }).versions;
}

const SOURCE = {
  html: '<section><h1>Forecast</h1><div data-slot="chart"></div><output data-slot="value"></output></section>',
  css: "section{font:16px system-ui;padding:1rem}",
  js: "artifact.ui.render({ type: \"chart\", rows: [] });\nglobalThis.onEvent = function(e){ artifact.ui.patch({ slot: \"value\", text: String(e.value) }); };",
};

function manifestFor(perms: string[]): string {
  return JSON.stringify({
    artifactSdkVersion: "1",
    runtimeVersion: "1",
    sourceSchemaVersion: "1",
    stateSchemaVersion: "1",
    requestedPermissions: perms,
    approvedPermissions: perms,
    entrypoints: { full: "main", compact: "compact" },
    resourceBudget: { maxMessagesPerSecond: 100 },
    sourceHash: "",
    buildHash: "",
    createdByUser: "sdk-test",
  });
}

async function publish(base: string, cookie: string, ws: string, artifactId: string, manifest: string, expectedBase = ""): Promise<string> {
  const before = new Set((await apiListVersions(base, cookie, ws, artifactId)).map((v) => v.versionId));
  const r = await postForm(base, `/w/${ws}/artifacts/${artifactId}/versions`, cookie, {
    html: SOURCE.html,
    css: SOURCE.css,
    js: SOURCE.js,
    manifest,
    expectedBaseVersionId: expectedBase,
    action: "publish",
  });
  expect(r.status).toBe(303);
  const fresh = (await apiListVersions(base, cookie, ws, artifactId)).find((v) => !before.has(v.versionId) && v.status === "ready");
  expect(fresh).toBeTruthy();
  return fresh!.versionId;
}

async function activate(base: string, cookie: string, ws: string, artifactId: string, versionId: string, expectedActive: string): Promise<void> {
  const r = await postForm(base, `/w/${ws}/artifacts/${artifactId}/activate`, cookie, { versionId, expectedActiveVersionId: expectedActive });
  expect(r.status).toBe(303);
}

async function openSession(base: string, cookie: string, ws: string, artifactId: string, versionId: string): Promise<string> {
  const r = await postJson(base, "/api/artifacts/sessions", cookie, { workspaceId: ws, artifactId, versionId });
  expect(r.status).toBe(201);
  return (r.json as { sessionId: string }).sessionId;
}

async function setupWorkspace(base: string, sub: string): Promise<{ cookie: string; workspaceId: string; userId: string }> {
  const cookie = await login(base, sub);
  const ws = await postJson(base, "/api/workspaces", cookie, { name: "W", baseCurrency: "EUR" });
  expect(ws.status).toBe(201);
  const workspaceId = (ws.json as { id: string }).id;
  const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub])).rows[0] as { id: string }).id;
  return { cookie, workspaceId, userId };
}

// 1 account + snapshot + monthly income: the parity/truncation fixture.
async function setupFinance(base: string, cookie: string, ws: string): Promise<{ accountId: string }> {
  const acc = await postJson(base, "/api/commands/accounts.create", cookie, { workspaceId: ws, name: "Cash", currency: "EUR", idempotencyKey: randomUUID() });
  expect(acc.status).toBe(200);
  const accountId = (acc.json as { id: string }).id;
  const snap = await postJson(base, "/api/commands/accounts.balance_snapshot", cookie, {
    workspaceId: ws, accountId, asOfDate: "2026-01-01", amount: "2000.00", currency: "EUR", idempotencyKey: randomUUID(),
  });
  expect(snap.status).toBe(200);
  const income = await postJson(base, "/api/commands/assumptions.set", cookie, {
    workspaceId: ws,
    assumptionType: "EXPECTED_INCOME",
    validFrom: "2026-01-01",
    value: { amountMinor: "100000", currency: "EUR", cadence: "MONTHLY", dayOfMonth: 1 },
    idempotencyKey: randomUUID(),
  });
  expect(income.status).toBe(200);
  return { accountId };
}

// Server-side quota counters live on the in-memory session: reset the window
// between bursts so consecutive test calls never trip the 60/minute cap.
function resetQuota(sessionId: string): void {
  const s = getArtifactSession(sessionId);
  expect(s).toBeTruthy();
  s!.rpcWindowStart = Date.now();
  s!.rpcWindowCount = 0;
  s!.rpcOutstanding = 0;
}

async function countFinance(workspaceId: string): Promise<Record<string, number>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace', $1, true)", [workspaceId]);
    const out: Record<string, number> = {};
    for (const t of ["projection_runs", "projection_points", "projection_events", "manual_transactions", "balance_snapshots", "transactions"]) {
      const r = await client.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE workspace_id = $1`, [workspaceId]);
      out[t] = (r.rows[0] as { n: number }).n;
    }
    await client.query("ROLLBACK");
    return out;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  pool = await ensureTestPool("E06-S04", "moneo_e06_sdk", [
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

describe("e06-s04 projection SDK (forecast.read)", () => {
  it("manifest requesting forecast.read builds; a bogus permission still 400s", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-proj-sdk-build");
    const source = { html: SOURCE.html, css: SOURCE.css, js: SOURCE.js };

    const ok = await postJson(base, "/api/artifacts/build", cookie, {
      workspaceId,
      artifactId: await apiCreateDraft(base, cookie, workspaceId, "Forecast card"),
      source,
      manifest: JSON.parse(manifestFor(["forecast.read"])),
    });
    expect(ok.status).toBe(201);
    expect(typeof (ok.json as { versionId: string }).versionId).toBe("string");

    const bogus = await postJson(base, "/api/artifacts/build", cookie, {
      workspaceId,
      artifactId: await apiCreateDraft(base, cookie, workspaceId, "Bogus card"),
      source,
      manifest: JSON.parse(manifestFor(["forecast.read", "ledger.write"])),
    });
    expect(bogus.status).toBe(400);
    expect(bogus.json).toMatchObject({ reason: "invalid_permissions" });
  });

  it("RPC projection matches HTTP POST /api/projection/run on ATS, coverage and first TOTAL point", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-proj-sdk-parity");
    const { accountId } = await setupFinance(base, cookie, workspaceId);
    const artifactId = await apiCreateDraft(base, cookie, workspaceId, "Forecast card");
    const versionId = await publish(base, cookie, workspaceId, artifactId, manifestFor(["forecast.read"]));
    await activate(base, cookie, workspaceId, artifactId, versionId, "");
    const sessionId = await openSession(base, cookie, workspaceId, artifactId, versionId);

    // RPC first: the HTTP run persists and bumps the workspace revision,
    // which (by design) stales open grants on the next call.
    resetQuota(sessionId);
    const rpc = await postJson(base, "/api/artifacts/sdk/rpc", cookie, {
      sessionId, method: "projection", args: { horizonDays: 30, spendingAccountId: accountId },
    });
    expect(rpc.status).toBe(200);

    const http = await postJson(base, "/api/projection/run", cookie, {
      workspaceId, horizonDays: 30, spendingAccountId: accountId, idempotencyKey: randomUUID(),
    });
    expect(http.status).toBe(200);
    const result = rpc.json.result as {
      horizonStart: string; horizonDays: number; baseCurrency: string; inputHash: string;
      coverage: Record<string, unknown>; ats: { status: string; amountMinor: string };
      points: { caseName: string; scope: string; pointDate: string; amountMinor: string; currencyCode: string }[];
      truncated: boolean;
    };
    expect(result.truncated).toBe(false);
    expect(result.horizonStart).toBe(http.json.horizonStart);
    expect(result.inputHash).toBe(http.json.inputHash);
    expect(result.ats.status).toBe(http.json.ats.status);
    expect(result.ats.amountMinor).toBe(http.json.ats.amountMinor);
    expect(result.coverage).toEqual(http.json.coverage);

    type HttpPoint = { case_name: string; scope: string; point_date: string; amount_minor: string };
    const byDate = (a: string, b: string): number => (a < b ? -1 : 1);
    const httpTotals = (http.json.points as HttpPoint[])
      .filter((p) => p.scope === "TOTAL" && p.case_name === "EXPECTED")
      .sort((a, b) => byDate(a.point_date, b.point_date));
    const sdkTotals = result.points
      .filter((p) => p.scope === "TOTAL" && p.caseName === "EXPECTED")
      .sort((a, b) => byDate(a.pointDate, b.pointDate));
    expect(httpTotals.length).toBe(30);
    expect(sdkTotals.length).toBe(30);
    expect(sdkTotals[0]).toMatchObject({ pointDate: httpTotals[0]!.point_date, amountMinor: httpTotals[0]!.amount_minor });
  });

  it("RPC without forecast.read is 403 permission_denied with zero finance writes", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-proj-sdk-noperm");
    await setupFinance(base, cookie, workspaceId);
    const artifactId = await apiCreateDraft(base, cookie, workspaceId, "Narrow card");
    const versionId = await publish(base, cookie, workspaceId, artifactId, manifestFor(["analytics.spending_by_category"]));
    await activate(base, cookie, workspaceId, artifactId, versionId, "");
    const before = await countFinance(workspaceId);
    const sessionId = await openSession(base, cookie, workspaceId, artifactId, versionId);

    resetQuota(sessionId);
    const denied = await postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId, method: "projection", args: { horizonDays: 30 } });
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ error: "permission_denied", requiredPermission: "forecast.read" });
    expect(await countFinance(workspaceId)).toEqual(before);
  });

  it("expired/stale grants are typed denials; archived artifacts 404", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-proj-sdk-gate");
    await setupFinance(base, cookie, workspaceId);
    const artifactId = await apiCreateDraft(base, cookie, workspaceId, "Forecast card");
    const versionId = await publish(base, cookie, workspaceId, artifactId, manifestFor(["forecast.read"]));
    await activate(base, cookie, workspaceId, artifactId, versionId, "");
    const claims = { userId, workspaceId };
    const grant = (sessionId: string) => withTenant(pool, claims, (client: PoolClient) =>
      client.query(`UPDATE artifact_runtime_grants SET expires_at = now() - interval '1 minute' WHERE workspace_id = $1 AND session_id = $2`, [workspaceId, sessionId]));

    const s1 = await openSession(base, cookie, workspaceId, artifactId, versionId);
    await grant(s1);
    resetQuota(s1);
    const expired = await postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId: s1, method: "projection", args: { horizonDays: 30 } });
    expect(expired.status).toBe(409);
    expect(expired.json).toMatchObject({ error: "conflict", reason: "grant_expired" });

    const s2 = await openSession(base, cookie, workspaceId, artifactId, versionId);
    await withTenant(pool, claims, (client: PoolClient) =>
      client.query(`UPDATE artifact_runtime_grants SET policy_revision = policy_revision + 1 WHERE workspace_id = $1 AND session_id = $2`, [workspaceId, s2]));
    resetQuota(s2);
    const stale = await postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId: s2, method: "projection", args: { horizonDays: 30 } });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: "conflict", reason: "grant_stale" });

    await withTenant(pool, claims, (client: PoolClient) =>
      client.query(`UPDATE artifacts SET archived_at = now() WHERE workspace_id = $1 AND id = $2`, [workspaceId, artifactId]));
    const reopened = await postJson(base, "/api/artifacts/sessions", cookie, { workspaceId, artifactId, versionId });
    expect(reopened.status).toBe(404);
    resetQuota(s2);
    const dead = await postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId: s2, method: "projection", args: { horizonDays: 30 } });
    expect(dead.status).toBe(404);
  });

  it("long horizons truncate to 500 points with truncated=true; 365 days exceeds the SDK cap", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-proj-sdk-trunc");
    const { accountId } = await setupFinance(base, cookie, workspaceId);
    const artifactId = await apiCreateDraft(base, cookie, workspaceId, "Forecast card");
    const versionId = await publish(base, cookie, workspaceId, artifactId, manifestFor(["forecast.read"]));
    await activate(base, cookie, workspaceId, artifactId, versionId, "");
    const sessionId = await openSession(base, cookie, workspaceId, artifactId, versionId);

    // 120d x 3 cases x 2 scopes (account + TOTAL) = 720 points > 500.
    resetQuota(sessionId);
    const long = await postJson(base, "/api/artifacts/sdk/rpc", cookie, {
      sessionId, method: "projection", args: { horizonDays: 120, spendingAccountId: accountId },
    });
    expect(long.status).toBe(200);
    expect(long.json.result.truncated).toBe(true);
    expect((long.json.result.points as unknown[])).toHaveLength(500);

    // The SDK window caps at 120 days (365 is an HTTP/evaluate horizon).
    resetQuota(sessionId);
    const over = await postJson(base, "/api/artifacts/sdk/rpc", cookie, {
      sessionId, method: "projection", args: { horizonDays: 365, spendingAccountId: accountId },
    });
    expect(over.status).toBe(500);
    expect(over.json).toEqual({ error: "rpc_failed" });
  });

  it("malformed projection args are rejected without finance effects", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-proj-sdk-badargs");
    await setupFinance(base, cookie, workspaceId);
    const artifactId = await apiCreateDraft(base, cookie, workspaceId, "Forecast card");
    const versionId = await publish(base, cookie, workspaceId, artifactId, manifestFor(["forecast.read"]));
    await activate(base, cookie, workspaceId, artifactId, versionId, "");
    const sessionId = await openSession(base, cookie, workspaceId, artifactId, versionId);
    const before = await countFinance(workspaceId);

    for (const args of [{ spendingAccountId: "not-a-uuid" }, { horizonDays: 0 }, { horizonDays: 30, nope: 1 }]) {
      resetQuota(sessionId);
      const bad = await postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId, method: "projection", args });
      expect(bad.status).toBe(500);
      expect(bad.json).toEqual({ error: "rpc_failed" });
    }
    expect(await countFinance(workspaceId)).toEqual(before);
  });
});
