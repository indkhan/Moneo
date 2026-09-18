// E01-S04 command/read contracts: accounts.rename idempotency, optimistic
// versions, exact decimal-string BIGINTs and HTTP/domain error agreement.
// Real PostgreSQL (`moneo_e01_commands`, fails closed without PG); synthetic
// users, workspaces and accounts only.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter } from "../apps/web/src/tenancy.ts";
import { accountViewSchema, getAccountView, renameInputSchema, validateRenameInput } from "../apps/web/src/commands/accounts.ts";
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

async function setupAccount(base: string, sub: string): Promise<{ cookie: string; workspaceId: string; accountId: string }> {
  const cookie = await login(base, sub);
  const ws = (await (await fetch(`${base}/api/workspaces`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "W", baseCurrency: "EUR" }),
  })).json()) as { id: string };
  const acct = (await (await fetch(`${base}/api/accounts`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: ws.id, name: "Checking" }),
  })).json()) as { id: string };
  return { cookie, workspaceId: ws.id, accountId: acct.id };
}

async function rename(base: string, cookie: string, body: unknown): Promise<{ status: number; text: string; json: unknown }> {
  const res = await fetch(`${base}/api/commands/accounts.rename`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as unknown };
}

beforeAll(async () => {
  // Own database: parallel vitest workers must not share suite state.
  pool = await ensureTestPool("E01-S04", "moneo_e01_commands", ["background_job_attempts", "job_dispatch_index", "outbox_events", "background_job_results", "background_jobs", "ai_dispatch_permits", "ai_exclusions", "ai_policies", "command_operations", "accounts", "workspace_members", "workspaces", "users", "app_sessions"]);
  stub = await startStubIssuer();
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e01-s04 command contracts", () => {
  it("rename happy path bumps the version and reads agree", async () => {
    const base = await startApp();
    const { cookie, workspaceId, accountId } = await setupAccount(base, "synthetic-cmd-a");
    const key = randomUUID();
    const first = await rename(base, cookie, { workspaceId, accountId, name: "Everyday", expectedVersion: "1", idempotencyKey: key });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ workspaceId, id: accountId, name: "Everyday", version: "2", replayed: false });
    expect(typeof (first.json as { operationId: string }).operationId).toBe("string");
    // Raw JSON carries decimal strings, never numbers.
    expect(first.text).toContain('"version":"2"');
    expect(first.text).not.toContain('"version":2');
    const got = await (await fetch(`${base}/api/accounts/${accountId}?workspaceId=${workspaceId}`, { headers: { cookie } })).json();
    expect(got).toMatchObject({ name: "Everyday", version: "2" });
  });

  it("same-key retry replays identically with one version bump", async () => {
    const base = await startApp();
    const { cookie, workspaceId, accountId } = await setupAccount(base, "synthetic-cmd-b");
    const key = randomUUID();
    const body = { workspaceId, accountId, name: "Bills", expectedVersion: "1", idempotencyKey: key };
    const first = await rename(base, cookie, body);
    const second = await rename(base, cookie, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ version: "2", replayed: true });
    expect((second.json as { operationId: string }).operationId).toBe((first.json as { operationId: string }).operationId);
    const got = await (await fetch(`${base}/api/accounts/${accountId}?workspaceId=${workspaceId}`, { headers: { cookie } })).json();
    expect((got as { version: string }).version).toBe("2");
  });

  it("same key with different params is rejected and the row is untouched", async () => {
    const base = await startApp();
    const { cookie, workspaceId, accountId } = await setupAccount(base, "synthetic-cmd-c");
    const key = randomUUID();
    await rename(base, cookie, { workspaceId, accountId, name: "One", expectedVersion: "1", idempotencyKey: key });
    const clash = await rename(base, cookie, { workspaceId, accountId, name: "Two", expectedVersion: "2", idempotencyKey: key });
    expect(clash.status).toBe(409);
    expect(clash.json).toEqual({ error: "conflict", reason: "idempotency_reuse" });
    const got = await (await fetch(`${base}/api/accounts/${accountId}?workspaceId=${workspaceId}`, { headers: { cookie } })).json();
    expect(got).toMatchObject({ name: "One", version: "2" });
  });

  it("stale versions conflict with the current version; concurrent writers converge to one winner", async () => {
    const base = await startApp();
    const { cookie, workspaceId, accountId } = await setupAccount(base, "synthetic-cmd-d");
    const stale = await rename(base, cookie, { workspaceId, accountId, name: "Stale", expectedVersion: "7", idempotencyKey: randomUUID() });
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({ error: "conflict", reason: "version_mismatch", currentVersion: "1" });
    const raced = await Promise.all([
      rename(base, cookie, { workspaceId, accountId, name: "Racer A", expectedVersion: "1", idempotencyKey: randomUUID() }),
      rename(base, cookie, { workspaceId, accountId, name: "Racer B", expectedVersion: "1", idempotencyKey: randomUUID() }),
    ]);
    const winners = raced.filter((r) => r.status === 200);
    const losers = raced.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].json).toMatchObject({ error: "conflict", reason: "version_mismatch", currentVersion: "2" });
  });

  it("expired keys fail explicitly instead of executing", async () => {
    const base = await startApp();
    const { cookie, workspaceId, accountId } = await setupAccount(base, "synthetic-cmd-e");
    const key = randomUUID();
    await rename(base, cookie, { workspaceId, accountId, name: "Fresh", expectedVersion: "1", idempotencyKey: key });
    // Backdate the replay window (test-only time travel; production TTL is 30 days).
    const user = (await pool.query("SELECT id FROM users WHERE auth_subject = $1", ["synthetic-cmd-e"])).rows[0].id as string;
    const { withTenant } = await import("../apps/web/src/tenancy.ts");
    await withTenant(pool, { userId: user, workspaceId }, async (client) => {
      await client.query("UPDATE command_operations SET expires_at = now() - interval '1 second' WHERE workspace_id = $1 AND idempotency_key = $2", [workspaceId, key]);
    });
    const replay = await rename(base, cookie, { workspaceId, accountId, name: "Fresh", expectedVersion: "2", idempotencyKey: key });
    expect(replay.status).toBe(409);
    expect(replay.json).toEqual({ error: "conflict", reason: "idempotency_expired" });
    const got = await (await fetch(`${base}/api/accounts/${accountId}?workspaceId=${workspaceId}`, { headers: { cookie } })).json();
    expect((got as { version: string }).version).toBe("2");
  });

  it("values past safe-integer round-trip exactly as decimal strings", async () => {
    const base = await startApp();
    const { cookie, workspaceId, accountId } = await setupAccount(base, "synthetic-cmd-f");
    const user = (await pool.query("SELECT id FROM users WHERE auth_subject = $1", ["synthetic-cmd-f"])).rows[0].id as string;
    const { withTenant } = await import("../apps/web/src/tenancy.ts");
    await withTenant(pool, { userId: user, workspaceId }, async (client) => {
      await client.query("UPDATE accounts SET version = '9007199254740993' WHERE workspace_id = $1 AND id = $2", [workspaceId, accountId]);
    });
    const raw = await (await fetch(`${base}/api/accounts/${accountId}?workspaceId=${workspaceId}`, { headers: { cookie } })).text();
    expect(raw).toContain('"version":"9007199254740993"');
    const renamed = await rename(base, cookie, { workspaceId, accountId, name: "Big", expectedVersion: "9007199254740993", idempotencyKey: randomUUID() });
    expect(renamed.status).toBe(200);
    expect(renamed.text).toContain('"version":"9007199254740994"');
  });

  it("HTTP and domain errors agree; contracts are single-sourced", async () => {
    expect(renameInputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(accountViewSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(() => validateRenameInput({})).toThrow();
    expect(() => validateRenameInput({ workspaceId: randomUUID(), accountId: randomUUID(), name: "x", expectedVersion: 2, idempotencyKey: randomUUID() })).toThrow();
    const base = await startApp();
    const { cookie, workspaceId, accountId } = await setupAccount(base, "synthetic-cmd-g");
    // 400 invalid, 404 missing/foreign share one body, 409 conflict variants.
    expect((await rename(base, cookie, { workspaceId, accountId, name: "", expectedVersion: "1", idempotencyKey: randomUUID() })).status).toBe(400);
    expect((await rename(base, cookie, { workspaceId, accountId, name: "x", expectedVersion: "01", idempotencyKey: randomUUID() })).status).toBe(400);
    const ghost = await rename(base, cookie, { workspaceId, accountId: randomUUID(), name: "x", expectedVersion: "1", idempotencyKey: randomUUID() });
    expect(ghost.status).toBe(404);
    expect(ghost.json).toEqual({ error: "not_found" });
    const foreign = await rename(base, cookie, { workspaceId: randomUUID(), accountId, name: "x", expectedVersion: "1", idempotencyKey: randomUUID() });
    expect(foreign.status).toBe(404);
    // Domain-level agreement: same codes without HTTP.
    const user = (await pool.query("SELECT id FROM users WHERE auth_subject = $1", ["synthetic-cmd-g"])).rows[0].id as string;
    const { withTenant } = await import("../apps/web/src/tenancy.ts");
    const outcome = await withTenant(pool, { userId: user, workspaceId }, async (client) => {
      const { renameAccountTx } = await import("../apps/web/src/commands/accounts.ts");
      return renameAccountTx(client, { userId: user, workspaceId }, user, { workspaceId, accountId, name: "Direct", expectedVersion: "1", idempotencyKey: randomUUID() });
    });
    if (!outcome.ok) throw new Error(`expected success, got ${outcome.code}`);
    expect(outcome.result.view.version).toBe("2");
    expect(await getAccountView(pool, { userId: user, workspaceId }, accountId)).toMatchObject({ version: "2" });
  });

  it("failed commands journal their error: replays are deterministic, and races converge", async () => {
    const base = await startApp();
    const { cookie, workspaceId, accountId } = await setupAccount(base, "synthetic-cmd-h");
    const key = randomUUID();
    const body = { workspaceId, accountId, name: "Never", expectedVersion: "7", idempotencyKey: key };
    const first = await rename(base, cookie, body);
    expect(first.status).toBe(409);
    expect(first.json).toEqual({ error: "conflict", reason: "version_mismatch", currentVersion: "1" });
    // Same key again AFTER a legitimate rename moved the version: the
    // recorded error replays instead of re-executing against new state.
    await rename(base, cookie, { workspaceId, accountId, name: "Legit", expectedVersion: "1", idempotencyKey: randomUUID() });
    const replay = await rename(base, cookie, body);
    expect(replay.status).toBe(409);
    expect(replay.json).toEqual({ error: "conflict", reason: "version_mismatch", currentVersion: "1" });
    // Ten parallel fresh-key renames on one version: exactly one winner.
    const racy = await Promise.all(
      Array.from({ length: 10 }, () => rename(base, cookie, { workspaceId, accountId, name: "Race", expectedVersion: "2", idempotencyKey: randomUUID() })),
    );
    expect(racy.filter((r) => r.status === 200)).toHaveLength(1);
    // Ten parallel identical failing retries on one key: all converge on the
    // single recorded outcome (B1 regression: no 503s, one journal row).
    const failKey = randomUUID();
    const failBody = { workspaceId, accountId, name: "SameFail", expectedVersion: "99", idempotencyKey: failKey };
    const racyFail = await Promise.all(Array.from({ length: 10 }, () => rename(base, cookie, failBody)));
    for (const r of racyFail) {
      expect(r.status).toBe(409);
      expect((r.json as { reason: string }).reason).toBe("version_mismatch");
    }
    const current = (await (await fetch(`${base}/api/accounts/${accountId}?workspaceId=${workspaceId}`, { headers: { cookie } })).json()) as { version: string };
    for (const r of racyFail) {
      expect(r.json).toEqual({ error: "conflict", reason: "version_mismatch", currentVersion: current.version });
    }
  });
});
