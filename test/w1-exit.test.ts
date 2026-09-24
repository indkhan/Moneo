// W1/E01 integrated exit demonstration (EPICS.md E01 exit): the merged
// stories passing TOGETHER against one app, one stub issuer, one real
// PostgreSQL database (`moneo_e01_w1`). Two synthetic users sign in and own
// isolated workspaces; swapped IDs fail at API and database boundaries;
// revoked sessions fail on API and reconnect; an optimistic conflict is
// visible; no privileged worker path bypasses isolation.

import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import type { Session } from "../apps/web/src/session-store.ts";
import { createControls } from "../apps/web/src/http-controls.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { getAccountView } from "../apps/web/src/commands/accounts.ts";
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
  const resolve = (req: IncomingMessage): Promise<Session | null> => requestSession(pool, sessionSecret, req);
  const server = createApp(createAuthRouter(config, pool), createTenancyRouter(pool, resolve), {
    ui: createUiRouter(pool, resolve, uiConfig),
    controls: createControls(),
    dbPing: async () => {
      const rows = await pool.query("SELECT 1 AS ok");
      return (rows.rowCount ?? 0) === 1;
    },
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
  expect(start.status).toBe(302);
  const callbackUrl = (await fetch(`${start.headers.get("location")!}&login_as=${loginAs}`, { redirect: "manual" })).headers.get("location")!;
  const done = await fetch(callbackUrl, { redirect: "manual" });
  expect(done.status).toBe(302);
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

beforeAll(async () => {
  // Own database: parallel vitest workers must not share suite state.
  pool = await ensureTestPool("W1-EXIT", "moneo_e01_w1_v2", ["fx_valuation", "fx_rates_ecb", "fx_rates_manual", "calculation_versions", "manual_transactions", "balance_snapshots", "balance_audit", "mapping_provider_usage", "mapping_provider_reservations", "mapping_proposals", "mapping_profiles", "review_decisions", "source_links", "transactions", "import_commit_batches", "parsed_observations", "source_objects", "imports", "data_sources", "background_job_attempts", "job_dispatch_index", "outbox_events", "background_job_results", "background_jobs", "ai_dispatch_permits", "ai_exclusions", "ai_policies", "command_operations", "accounts", "workspace_members", "workspaces", "users", "app_sessions"]);
  stub = await startStubIssuer();
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("w1 exit: isolated two-tenant slice", () => {
  it("sign-in, isolated workspaces, swapped-ID denial, revocation, conflict, no bypass", async () => {
    const base = await startApp();

    // 1. Two synthetic users sign in and create isolated workspaces.
    const cookieA = await login(base, "w1-user-a");
    const cookieB = await login(base, "w1-user-b");
    const wsA = ((await postJson(base, "/api/workspaces", cookieA, { name: "WA", baseCurrency: "EUR" })).json as { id: string }).id;
    const wsB = ((await postJson(base, "/api/workspaces", cookieB, { name: "WB", baseCurrency: "USD" })).json as { id: string }).id;
    expect(wsA).not.toBe(wsB);
    const acctA = ((await postJson(base, "/api/accounts", cookieA, { workspaceId: wsA, name: "A-checking" })).json as { id: string }).id;
    const acctB = ((await postJson(base, "/api/accounts", cookieB, { workspaceId: wsB, name: "B-checking" })).json as { id: string }).id;

    // 2. Tenant-swapped IDs fail at the API boundary (uniform 404s).
    expect((await fetch(`${base}/api/accounts/${acctB}?workspaceId=${wsA}`, { headers: { cookie: cookieA } })).status).toBe(404);
    expect((await fetch(`${base}/api/accounts?workspaceId=${wsB}`, { headers: { cookie: cookieA } })).status).toBe(404);
    expect(((await postJson(base, "/api/accounts", cookieA, { workspaceId: wsB, name: "Sneak" })).json as { error: string }).error).toBe("not_found");

    // 3. ...and at the real database boundary under RLS + membership.
    const userA = (await pool.query("SELECT id FROM users WHERE auth_subject = $1", ["w1-user-a"])).rows[0].id as string;
    await withTenant(pool, { userId: userA, workspaceId: wsA }, async (client: PoolClient) => {
      expect((await client.query("SELECT id FROM accounts WHERE id = $1", [acctB])).rowCount).toBe(0);
      expect(((await client.query("SELECT count(*)::int AS n FROM accounts")).rows[0] as { n: number }).n).toBe(1);
    });

    // 4. Revoked sessions fail on API and reconnect.
    expect((await fetch(`${base}/api/me`, { headers: { cookie: cookieA } })).status).toBe(200);
    await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: cookieA, origin: base } });
    expect((await fetch(`${base}/api/me`, { headers: { cookie: cookieA } })).status).toBe(401);
    expect((await fetch(`${base}/api/me`, { headers: { cookie: cookieA } })).status).toBe(401); // reconnect
    // B's session is unaffected.
    expect((await fetch(`${base}/api/me`, { headers: { cookie: cookieB } })).status).toBe(200);

    // 5. An optimistic conflict is visible (B renames twice on one version).
    const key1 = randomUUID();
    const first = await postJson(base, "/api/commands/accounts.rename", cookieB, { workspaceId: wsB, accountId: acctB, name: "B-bills", expectedVersion: "1", idempotencyKey: key1 });
    expect(first.status).toBe(200);
    const clash = await postJson(base, "/api/commands/accounts.rename", cookieB, { workspaceId: wsB, accountId: acctB, name: "B-other", expectedVersion: "1", idempotencyKey: randomUUID() });
    expect(clash.status).toBe(409);
    expect(clash.json).toMatchObject({ error: "conflict", reason: "version_mismatch", currentVersion: "2" });

    // 6. No privileged worker bypass: membership-less claims deny on every
    // tenant read, including the domain functions workers would reuse.
    const outsider = randomUUID();
    await expect(withTenant(pool, { userId: outsider, workspaceId: wsB }, async () => "ran")).rejects.toThrow("tenant_denied");
    await expect(getAccountView(pool, { userId: outsider, workspaceId: wsB }, acctB)).rejects.toThrow("tenant_denied");
    // Revoked A cannot reach even its own rows through the API anymore.
    expect((await fetch(`${base}/api/accounts/${acctA}?workspaceId=${wsA}`, { headers: { cookie: cookieA } })).status).toBe(401);
  });
});
