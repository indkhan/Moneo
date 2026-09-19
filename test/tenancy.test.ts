// E01-S03 tenant ownership: two synthetic users, isolated workspaces, real
// PostgreSQL (`moneo_e01_tenancy`, fails closed without PG). Proves API-level
// and database-level isolation, tenant-swapped denial, connection hygiene,
// least-privilege role posture, FORCED RLS, and migration rollback.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { migrate } from "../apps/web/src/db.ts";
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

async function json(method: string, url: string, cookie: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  // Own database: parallel vitest workers must not share a database with a
  // suite whose rollback test drops tables.
  pool = await ensureTestPool("E01-S03", "moneo_e01_tenancy_v4", ["workspace_data_revision", "calculation_versions", "fx_valuation", "fx_rates_ecb", "fx_rates_manual", "manual_transactions", "balance_snapshots", "balance_audit", "mapping_provider_usage", "mapping_provider_reservations", "mapping_proposals", "mapping_profiles", "review_decisions", "source_links", "transactions", "import_commit_batches", "parsed_observations", "source_objects", "imports", "data_sources", "background_job_attempts", "job_dispatch_index", "outbox_events", "background_job_results", "background_jobs", "ai_dispatch_permits", "ai_exclusions", "ai_policies", "command_operations", "accounts", "workspace_members", "workspaces", "users", "app_sessions"]);
  stub = await startStubIssuer();
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e01-s03 tenant ownership", () => {
  it("two users own isolated workspaces over HTTP with uniform 404s", async () => {
    const base = await startApp();
    const cookieA = await login(base, "synthetic-tenant-a");
    const cookieB = await login(base, "synthetic-tenant-b");

    const wsA = (await json("POST", `${base}/api/workspaces`, cookieA, { name: "Household A", baseCurrency: "EUR", timezone: "Europe/Berlin" })) as { status: number; body: { id: string } };
    expect(wsA.status).toBe(201);
    const wsB = (await json("POST", `${base}/api/workspaces`, cookieB, { name: "Household B", baseCurrency: "USD" })) as { status: number; body: { id: string } };
    expect(wsB.status).toBe(201);

    const acctA = (await json("POST", `${base}/api/accounts`, cookieA, { workspaceId: wsA.body.id, name: "Checking A" })) as { status: number; body: { id: string } };
    expect(acctA.status).toBe(201);
    const acctB = (await json("POST", `${base}/api/accounts`, cookieB, { workspaceId: wsB.body.id, name: "Checking B" })) as { status: number; body: { id: string } };
    expect(acctB.status).toBe(201);

    // Lists are scoped.
    const listA = await json("GET", `${base}/api/accounts?workspaceId=${wsA.body.id}`, cookieA) as { status: number; body: { accounts: { workspaceId: string; id: string; name: string; version: string; currency: string; archived: boolean; source: "manual" | "import"; createdAt: string; updatedAt: string }[] } };
    expect(listA.body.accounts).toHaveLength(1);
    expect(listA.body.accounts[0]).toMatchObject({ workspaceId: wsA.body.id, id: acctA.body.id, name: "Checking A", version: "1", currency: "EUR", archived: false, source: "manual" });
    expect(typeof listA.body.accounts[0].createdAt).toBe("string");
    expect(typeof listA.body.accounts[0].updatedAt).toBe("string");
    const listWSA = await json("GET", `${base}/api/workspaces`, cookieA) as { status: number; body: { workspaces: { id: string }[] } };
    expect(listWSA.body.workspaces.map((w) => w.id)).toEqual([wsA.body.id]);

    // Tenant-swapped IDs are indistinguishable from missing IDs.
    const swapped = await json("GET", `${base}/api/accounts/${acctB.body.id}?workspaceId=${wsA.body.id}`, cookieA);
    expect(swapped.status).toBe(404);
    expect(swapped.body).toEqual({ error: "not_found" });
    const swappedWs = await json("GET", `${base}/api/accounts?workspaceId=${wsB.body.id}`, cookieA);
    expect(swappedWs.status).toBe(404);
    expect(swappedWs.body).toEqual({ error: "not_found" });
    const missing = await json("GET", `${base}/api/accounts/${randomUUID()}?workspaceId=${wsA.body.id}`, cookieA);
    expect(missing.status).toBe(swapped.status);
    expect(missing.body).toEqual(swapped.body);

    // Writing into a foreign workspace fails the same way.
    const writeForeign = await json("POST", `${base}/api/accounts`, cookieA, { workspaceId: wsB.body.id, name: "Sneaky" });
    expect(writeForeign.status).toBe(404);

    // Unauthenticated tenant calls are 401, not 404 (auth boundary first).
    const anon = await json("GET", `${base}/api/accounts?workspaceId=${wsA.body.id}`, "moneo_session=expired");
    expect(anon.status).toBe(401);
  });

  it("database boundaries deny foreign reads/writes under real RLS", async () => {
    const base = await startApp();
    const cookieA = await login(base, "synthetic-tenant-c");
    const cookieB = await login(base, "synthetic-tenant-d");
    const wsA = ((await json("POST", `${base}/api/workspaces`, cookieA, { name: "WA", baseCurrency: "EUR" })).body as { id: string }).id;
    const wsB = ((await json("POST", `${base}/api/workspaces`, cookieB, { name: "WB", baseCurrency: "EUR" })).body as { id: string }).id;
    const acctB = ((await json("POST", `${base}/api/accounts`, cookieB, { workspaceId: wsB, name: "B-acct" })).body as { id: string }).id;
    const userA = (await pool.query("SELECT id FROM users WHERE auth_subject = $1", ["synthetic-tenant-c"])).rows[0].id as string;

    // Direct read under A's context sees zero B rows.
    await withTenant(pool, { userId: userA, workspaceId: wsA }, async (client: PoolClient) => {
      const rows = await client.query("SELECT id FROM accounts WHERE id = $1", [acctB]);
      expect(rows.rowCount).toBe(0);
      const all = await client.query("SELECT count(*)::int AS n FROM accounts");
      expect((all.rows[0] as { n: number }).n).toBe(0);
    });

    // Unscoped pooled reads see zero tenant rows (fail closed, no error oracle).
    const bare = await pool.connect();
    try {
      expect(((await bare.query("SELECT count(*)::int AS n FROM accounts")).rows[0] as { n: number }).n).toBe(0);
      expect(((await bare.query("SELECT count(*)::int AS n FROM workspaces")).rows[0] as { n: number }).n).toBe(0);
      expect(((await bare.query("SELECT count(*)::int AS n FROM workspace_members")).rows[0] as { n: number }).n).toBe(0);
      await expect(bare.query("INSERT INTO accounts (workspace_id, id, name) VALUES ($1, $2, $3)", [wsA, randomUUID(), "Nope"])).rejects.toThrow();
    } finally {
      bare.release();
    }

    // Relational integrity: accounts cannot point at a missing workspace. From
    // app paths RLS denies first (WITH CHECK), so the FK is the third layer
    // for privileged/owner access; either way no orphan row is created. The
    // savepoint keeps the aborted INSERT from poisoning the transaction.
    await withTenant(pool, { userId: userA, workspaceId: wsA }, async (client: PoolClient) => {
      await client.query("SAVEPOINT hostile_insert");
      await expect(client.query("INSERT INTO accounts (workspace_id, id, name) VALUES ($1, $2, $3)", [randomUUID(), randomUUID(), "Orphan"])).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT hostile_insert");
      const orphans = await client.query("SELECT count(*)::int AS n FROM accounts WHERE name = 'Orphan'");
      expect((orphans.rows[0] as { n: number }).n).toBe(0);
    });

    // Composite keys: the same account UUID may exist in both workspaces yet stay invisible across the boundary.
    await withTenant(pool, { userId: userA, workspaceId: wsA }, async (client: PoolClient) => {
      await client.query("INSERT INTO accounts (workspace_id, id, name) VALUES ($1, $2, $3)", [wsA, acctB, "Same id, own side"]);
      const mine = await client.query("SELECT name FROM accounts WHERE workspace_id = $1 AND id = $2", [wsA, acctB]);
      expect((mine.rows[0] as { name: string }).name).toBe("Same id, own side");
    });
    const stillB = await json("GET", `${base}/api/accounts/${acctB}?workspaceId=${wsB}`, cookieB);
    expect((stillB.body as { name: string }).name).toBe("B-acct");

    // Non-member context throws before executing work.
    const outsider = randomUUID();
    await expect(withTenant(pool, { userId: outsider, workspaceId: wsA }, async () => "executed")).rejects.toThrow("tenant_denied");
  });

  it("malformed bodies and invalid fields fail 400 without leaking tenant state", async () => {
    const base = await startApp();
    const cookie = await login(base, "synthetic-tenant-f");
    const ws = ((await json("POST", `${base}/api/workspaces`, cookie, { name: "WF", baseCurrency: "EUR" })).body as { id: string }).id;
    // Malformed JSON.
    const bad = await fetch(`${base}/api/accounts`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{oops" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_request" });
    // Oversized body.
    const big = await fetch(`${base}/api/accounts`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: ws, name: "x".repeat(70 * 1024) }) });
    expect(big.status).toBe(400);
    // Invalid fields (empty name, bad currency) are 400, not 404.
    const emptyName = await json("POST", `${base}/api/accounts`, cookie, { workspaceId: ws, name: "" });
    expect(emptyName.status).toBe(400);
    const badCurrency = await json("POST", `${base}/api/workspaces`, cookie, { name: "W", baseCurrency: "euro" });
    expect(badCurrency.status).toBe(400);
    // Nothing was created by the failed calls.
    const list = await json("GET", `${base}/api/accounts?workspaceId=${ws}`, cookie);
    expect(list.body).toEqual({ accounts: [] });
  });

  it("pooled connections never retain tenant identity", async () => {
    const base = await startApp();
    const cookie = await login(base, "synthetic-tenant-e");
    const ws = ((await json("POST", `${base}/api/workspaces`, cookie, { name: "WE", baseCurrency: "CHF" })).body as { id: string }).id;
    const user = (await pool.query("SELECT id FROM users WHERE auth_subject = $1", ["synthetic-tenant-e"])).rows[0].id as string;

    await withTenant(pool, { userId: user, workspaceId: ws }, async (client: PoolClient) => {
      expect((await client.query("SELECT current_setting('app.current_workspace', true) AS v")).rows[0]).toMatchObject({ v: ws });
    });
    // Same pool, fresh checkout: settings are gone.
    const probe = await pool.connect();
    try {
      expect((await probe.query("SELECT current_setting('app.current_workspace', true) AS v")).rows[0]).toMatchObject({ v: "" });
      expect((await probe.query("SELECT current_setting('app.current_user', true) AS v")).rows[0]).toMatchObject({ v: "" });
    } finally {
      probe.release();
    }
  });

  it("app role is least-privilege and RLS is forced", async () => {
    const role = await pool.query("SELECT current_user AS u, rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user");
    expect(role.rows[0]).toMatchObject({ super: false, bypass: false });
    const forced = await pool.query("SELECT relname, relforcerowsecurity AS forced FROM pg_class WHERE relname IN ('workspaces', 'workspace_members', 'accounts')");
    expect(forced.rows).toHaveLength(3);
    for (const row of forced.rows as { relname: string; forced: boolean }[]) {
      expect(row.forced).toBe(true);
    }
  });

  it("migrations 009 then 008 then 007 then 006 then 005 then 004 then 003 then 002 roll back and re-apply on the suite database", async () => {
    const { readFileSync } = await import("node:fs");
    // Newest first while recorded, otherwise re-migrate never restores the
    // dependents (010 accounts manual balances references accounts; 009 import commit references imports/observations; 008 mapping
    // tables reference imports; 007 staging references workspaces/imports;
    // 006 attempts reference jobs; 005 jobs reference workspaces/operations;
    // 004 exclusions reference accounts; 002 drops the accounts table carrying
    // 003's version column).
    for (const file of ["013_calculation_evidence.rollback.sql", "012_fx_rates.rollback.sql", "011_calculation_versions.rollback.sql", "010_accounts_manual_balances.rollback.sql", "009_import_commit.rollback.sql", "008_mapping.rollback.sql", "007_uploads.rollback.sql", "006_job_recovery.rollback.sql", "005_jobs.rollback.sql", "004_ai_policy.rollback.sql", "003_commands.rollback.sql", "002_tenancy.rollback.sql"]) {
      const sql = readFileSync(`apps/web/migrations/${file}`, "utf8");
      const admin = await pool.connect();
      try {
        await admin.query("BEGIN");
        await admin.query(sql);
        await admin.query("COMMIT");
      } catch (err) {
        try {
          await admin.query("ROLLBACK");
        } catch { /* preserve */ }
        throw err;
      } finally {
        admin.release();
      }
    }
    // Rollbacks don't clear schema_migrations; clear it so migrate re-applies.
    await pool.query("TRUNCATE schema_migrations");
    const gone = await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('users', 'workspaces', 'workspace_members', 'accounts', 'command_operations', 'ai_policies', 'ai_exclusions', 'ai_dispatch_permits', 'background_jobs', 'background_job_results', 'outbox_events', 'job_dispatch_index', 'background_job_attempts', 'data_sources', 'imports', 'source_objects', 'parsed_observations', 'mapping_profiles', 'mapping_proposals', 'mapping_provider_reservations', 'mapping_provider_usage', 'transactions', 'source_links', 'review_decisions', 'import_commit_batches', 'manual_transactions', 'balance_snapshots', 'balance_audit')");
    expect((gone.rows[0] as { n: number }).n).toBe(0);
    // Self-healing: the idempotent migrator restores the full shape.
    await migrate(pool, "apps/web/migrations");
    const back = await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('users', 'workspaces', 'workspace_members', 'accounts', 'command_operations', 'ai_policies', 'ai_exclusions', 'ai_dispatch_permits', 'background_jobs', 'background_job_results', 'outbox_events', 'job_dispatch_index', 'background_job_attempts', 'data_sources', 'imports', 'source_objects', 'parsed_observations', 'mapping_profiles', 'mapping_proposals', 'mapping_provider_reservations', 'mapping_provider_usage', 'transactions', 'source_links', 'review_decisions', 'import_commit_batches', 'manual_transactions', 'balance_snapshots', 'balance_audit')");
    expect((back.rows[0] as { n: number }).n).toBe(28);
    const versionCol = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'version'");
    expect(versionCol.rowCount).toBe(1);
  });
});
