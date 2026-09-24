// E03-S01 accounts, manual transactions, and balance snapshots: exact money,
// tenant isolation, idempotency, optimistic versions, and cutoff semantics.
// Real PostgreSQL (`moneo_e03_accounts`, fails closed without PG); synthetic
// users, workspaces, accounts, transactions, and balance snapshots only.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter } from "../apps/web/src/tenancy.ts";
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

async function postJson(base: string, path: string, cookie: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function getJson(base: string, path: string, cookie: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  return { status: res.status, json: await res.json() };
}

async function setupWorkspace(base: string, sub: string): Promise<{ cookie: string; workspaceId: string }> {
  const cookie = await login(base, sub);
  const ws = (await postJson(base, "/api/workspaces", cookie, { name: "W", baseCurrency: "EUR" })).json as { id: string };
  return { cookie, workspaceId: ws.id };
}

beforeAll(async () => {
  pool = await ensureTestPool("E03-S01", "moneo_e03_accounts_v2", [
    "fx_valuation",
    "fx_rates_ecb",
    "fx_rates_manual",
    "calculation_versions",
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
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e03-s01 accounts, manual transactions, balance snapshots", () => {
  it("creates an account with currency and returns full view", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-acct-a");
    const key = randomUUID();
    const created = await postJson(base, "/api/commands/accounts.create", cookie, {
      workspaceId,
      name: "Checking",
      currency: "EUR",
      idempotencyKey: key,
    });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({
      workspaceId,
      name: "Checking",
      currency: "EUR",
      archived: false,
      source: "manual",
      version: "1",
      replayed: false,
    });
    expect(typeof (created.json as { operationId: string }).operationId).toBe("string");
    expect(typeof (created.json as { createdAt: string }).createdAt).toBe("string");
    expect(typeof (created.json as { updatedAt: string }).updatedAt).toBe("string");
    // Replay returns identical result
    const replay = await postJson(base, "/api/commands/accounts.create", cookie, {
      workspaceId,
      name: "Checking",
      currency: "EUR",
      idempotencyKey: key,
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ replayed: true });
    expect((replay.json as { operationId: string }).operationId).toBe((created.json as { operationId: string }).operationId);
  });

  it("rejects unknown currency on account create", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-acct-b");
    const created = await postJson(base, "/api/commands/accounts.create", cookie, {
      workspaceId,
      name: "Checking",
      currency: "XXX",
      idempotencyKey: randomUUID(),
    });
    expect(created.status).toBe(400);
    expect(created.json).toEqual({ error: "invalid_request" });
  });

  it("updates account name and archives with optimistic versioning", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-acct-c");
    const createKey = randomUUID();
    const created = await postJson(base, "/api/commands/accounts.create", cookie, {
      workspaceId,
      name: "Original",
      currency: "EUR",
      idempotencyKey: createKey,
    });
    expect(created.status).toBe(200);
    const accountId = (created.json as { id: string }).id;

    // Update name with correct version
    const updateKey = randomUUID();
    const updated = await postJson(base, "/api/commands/accounts.update", cookie, {
      workspaceId,
      accountId,
      expectedVersion: "1",
      name: "Renamed",
      idempotencyKey: updateKey,
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ name: "Renamed", version: "2", replayed: false });

    // Stale version conflicts
    const stale = await postJson(base, "/api/commands/accounts.update", cookie, {
      workspaceId,
      accountId,
      expectedVersion: "1",
      name: "Stale",
      idempotencyKey: randomUUID(),
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({ error: "conflict", reason: "version_mismatch", currentVersion: "2" });

    // Archive
    const archiveKey = randomUUID();
    const archived = await postJson(base, "/api/commands/accounts.update", cookie, {
      workspaceId,
      accountId,
      expectedVersion: "2",
      archived: true,
      idempotencyKey: archiveKey,
    });
    expect(archived.status).toBe(200);
    expect(archived.json).toMatchObject({ archived: true, version: "3" });
  });

  it("creates manual transactions with exact minor units", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-acct-d");
    const createKey = randomUUID();
    const created = await postJson(base, "/api/commands/accounts.create", cookie, {
      workspaceId,
      name: "Cash",
      currency: "EUR",
      idempotencyKey: createKey,
    });
    const accountId = (created.json as { id: string }).id;

    // INFLOW
    const inflowKey = randomUUID();
    const inflow = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId,
      amount: "100.00",
      currency: "EUR",
      direction: "INFLOW",
      effectiveDate: "2024-01-15",
      description: "Salary",
      reference: "REF-001",
      idempotencyKey: inflowKey,
    });
    expect(inflow.status).toBe(200);
    expect(inflow.json).toMatchObject({
      accountId,
      amountMinor: "10000",
      currency: "EUR",
      direction: "INFLOW",
      effectiveDate: "2024-01-15",
      description: "Salary",
      reference: "REF-001",
      replayed: false,
    });
    expect(typeof (inflow.json as { id: string }).id).toBe("string");
    expect(typeof (inflow.json as { actorId: string }).actorId).toBe("string");
    expect(typeof (inflow.json as { createdAt: string }).createdAt).toBe("string");

    // OUTFLOW
    const outflowKey = randomUUID();
    const outflow = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId,
      amount: "25.50",
      currency: "EUR",
      direction: "OUTFLOW",
      effectiveDate: "2024-01-16",
      description: "Groceries",
      idempotencyKey: outflowKey,
    });
    expect(outflow.status).toBe(200);
    expect(outflow.json).toMatchObject({
      amountMinor: "2550",
      direction: "OUTFLOW",
    });

    // JPY (0 decimal places)
    const jpyKey = randomUUID();
    const jpy = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId,
      amount: "10000",
      currency: "JPY",
      direction: "OUTFLOW",
      effectiveDate: "2024-01-17",
      description: "Tokyo trip",
      idempotencyKey: jpyKey,
    });
    expect(jpy.status).toBe(200);
    expect(jpy.json).toMatchObject({ amountMinor: "10000", currency: "JPY" });

    // KWD (3 decimal places)
    const kwdKey = randomUUID();
    const kwd = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId,
      amount: "1.234",
      currency: "KWD",
      direction: "INFLOW",
      effectiveDate: "2024-01-18",
      description: "Kuwait income",
      idempotencyKey: kwdKey,
    });
    expect(kwd.status).toBe(200);
    expect(kwd.json).toMatchObject({ amountMinor: "1234", currency: "KWD" });

    // Replay same key returns identical
    const replay = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId,
      amount: "100.00",
      currency: "EUR",
      direction: "INFLOW",
      effectiveDate: "2024-01-15",
      description: "Salary",
      reference: "REF-001",
      idempotencyKey: inflowKey,
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ replayed: true });
    expect((replay.json as { operationId: string }).operationId).toBe((inflow.json as { operationId: string }).operationId);
  });

  it("rejects excess precision for currency", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-acct-e");
    const createKey = randomUUID();
    await postJson(base, "/api/commands/accounts.create", cookie, {
      workspaceId,
      name: "Cash",
      currency: "EUR",
      idempotencyKey: createKey,
    });
    // NOTE (E03-S08 exit): this must be a real account id so the request
    // reaches amount parsing — passing the whole body object would 400 on
    // the accountId shape instead of exercising precision.
    const accountId = ((await postJson(base, "/api/accounts", cookie, { workspaceId, name: "Temp" })).json as { id: string }).id;

    // EUR with 3 decimal places should fail
    const bad = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId,
      amount: "1.234",
      currency: "EUR",
      direction: "OUTFLOW",
      effectiveDate: "2024-01-15",
      description: "Bad precision",
      idempotencyKey: randomUUID(),
    });
    expect(bad.status).toBe(400);
  });

  it("creates and reads balance snapshots with signed amounts", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-acct-f");
    const createKey = randomUUID();
    const created = await postJson(base, "/api/commands/accounts.create", cookie, {
      workspaceId,
      name: "Savings",
      currency: "EUR",
      idempotencyKey: createKey,
    });
    const accountId = (created.json as { id: string }).id;

    // Positive balance
    const snapKey1 = randomUUID();
    const snap1 = await postJson(base, "/api/commands/accounts.balance_snapshot", cookie, {
      workspaceId,
      accountId,
      asOfDate: "2024-01-01",
      amount: "1000.00",
      currency: "EUR",
      source: "manual",
      freshness: "current",
      reconciliationState: "unreconciled",
      idempotencyKey: snapKey1,
    });
    expect(snap1.status).toBe(200);
    expect(snap1.json).toMatchObject({
      accountId,
      asOfDate: "2024-01-01",
      amountMinor: "100000",
      currency: "EUR",
      source: "manual",
      freshness: "current",
      reconciliationState: "unreconciled",
      replayed: false,
    });
    const snapshotId = (snap1.json as { id: string }).id;

    // Negative balance (overdraft)
    const snapKey2 = randomUUID();
    const snap2 = await postJson(base, "/api/commands/accounts.balance_snapshot", cookie, {
      workspaceId,
      accountId,
      asOfDate: "2024-02-01",
      amount: "-500.00",
      currency: "EUR",
      idempotencyKey: snapKey2,
    });
    expect(snap2.status).toBe(200);
    expect(snap2.json).toMatchObject({
      amountMinor: "-50000",
    });

    // Zero balance
    const snapKey3 = randomUUID();
    const snap3 = await postJson(base, "/api/commands/accounts.balance_snapshot", cookie, {
      workspaceId,
      accountId,
      asOfDate: "2024-03-01",
      amount: "0",
      currency: "EUR",
      idempotencyKey: snapKey3,
    });
    expect(snap3.status).toBe(200);
    expect(snap3.json).toMatchObject({ amountMinor: "0" });

    // Read snapshots list
    const list = await getJson(base, `/api/accounts/${accountId}/balance_snapshots?workspaceId=${workspaceId}`, cookie);
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ snapshots: expect.arrayContaining([
      expect.objectContaining({ asOfDate: "2024-01-01", amountMinor: "100000" }),
      expect.objectContaining({ asOfDate: "2024-02-01", amountMinor: "-50000" }),
      expect.objectContaining({ asOfDate: "2024-03-01", amountMinor: "0" }),
    ]) });

    // Read single snapshot
    const getSnap = await getJson(base, `/api/balance_snapshots/${snapshotId}?workspaceId=${workspaceId}`, cookie);
    expect(getSnap.status).toBe(200);
    expect(getSnap.json).toMatchObject({ asOfDate: "2024-01-01", amountMinor: "100000" });
  });

  it("corrects balance snapshots with audit trail", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-acct-g");
    const createKey = randomUUID();
    const created = await postJson(base, "/api/commands/accounts.create", cookie, {
      workspaceId,
      name: "Checking",
      currency: "EUR",
      idempotencyKey: createKey,
    });
    const accountId = (created.json as { id: string }).id;

    // Create initial snapshot
    const snapKey = randomUUID();
    const snap = await postJson(base, "/api/commands/accounts.balance_snapshot", cookie, {
      workspaceId,
      accountId,
      asOfDate: "2024-01-01",
      amount: "1000.00",
      currency: "EUR",
      idempotencyKey: snapKey,
    });
    const snapshotId = (snap.json as { id: string }).id;

    // Correct it
    const corrKey = randomUUID();
    const corr = await postJson(base, "/api/commands/accounts.balance_correction", cookie, {
      workspaceId,
      snapshotId,
      newAmount: "1500.00",
      currency: "EUR",
      reason: "Found missing deposit",
      idempotencyKey: corrKey,
    });
    expect(corr.status).toBe(200);
    expect(corr.json).toMatchObject({
      snapshotId,
      action: "correct",
      priorAmountMinor: "100000",
      newAmountMinor: "150000",
      currency: "EUR",
      reason: "Found missing deposit",
      replayed: false,
    });

    // Read audit trail
    const audit = await getJson(base, `/api/balance_snapshots/${snapshotId}/audit?workspaceId=${workspaceId}`, cookie) as { status: number; json: { audit: { action: string; priorAmountMinor: string | null; newAmountMinor: string; reason: string }[] } };
    expect(audit.status).toBe(200);
    expect(audit.json.audit).toHaveLength(2); // create + correct
    expect(audit.json.audit[0]).toMatchObject({ action: "create", priorAmountMinor: null, newAmountMinor: "100000" });
    expect(audit.json.audit[1]).toMatchObject({ action: "correct", priorAmountMinor: "100000", newAmountMinor: "150000", reason: "Found missing deposit" });

    // Replay correction returns same result
    const corrReplay = await postJson(base, "/api/commands/accounts.balance_correction", cookie, {
      workspaceId,
      snapshotId,
      newAmount: "1500.00",
      currency: "EUR",
      reason: "Found missing deposit",
      idempotencyKey: corrKey,
    });
    expect(corrReplay.status).toBe(200);
    expect(corrReplay.json).toMatchObject({ replayed: true });
  });

  it("lists manual transactions for an account", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-acct-h");
    const createKey = randomUUID();
    const created = await postJson(base, "/api/commands/accounts.create", cookie, {
      workspaceId,
      name: "Cash",
      currency: "EUR",
      idempotencyKey: createKey,
    });
    const accountId = (created.json as { id: string }).id;

    await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId,
      amount: "100.00",
      currency: "EUR",
      direction: "INFLOW",
      effectiveDate: "2024-01-15",
      description: "First",
      idempotencyKey: randomUUID(),
    });
    await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId,
      amount: "50.00",
      currency: "EUR",
      direction: "OUTFLOW",
      effectiveDate: "2024-01-16",
      description: "Second",
      idempotencyKey: randomUUID(),
    });

    const list = await getJson(base, `/api/accounts/${accountId}/manual_transactions?workspaceId=${workspaceId}`, cookie) as { status: number; json: { transactions: { description: string }[] } };
    expect(list.status).toBe(200);
    expect(list.json.transactions).toHaveLength(2);
    // Ordered by effective_date DESC, created_at DESC
    expect(list.json.transactions[0].description).toBe("Second");
    expect(list.json.transactions[1].description).toBe("First");
  });

  it("enforces tenant isolation for all new endpoints", async () => {
    const base = await startApp();
    const { cookie: cookieA, workspaceId: wsA } = await setupWorkspace(base, "e03-tenant-a");
    const { cookie: cookieB, workspaceId: wsB } = await setupWorkspace(base, "e03-tenant-b");

    // User A creates account
    const createKey = randomUUID();
    const created = await postJson(base, "/api/commands/accounts.create", cookieA, {
      workspaceId: wsA,
      name: "A's account",
      currency: "EUR",
      idempotencyKey: createKey,
    });
    const accountIdA = (created.json as { id: string }).id;

    // User B cannot access A's account
    const swap = await postJson(base, "/api/commands/accounts.update", cookieB, {
      workspaceId: wsB,
      accountId: accountIdA,
      expectedVersion: "1",
      name: "Hacked",
      idempotencyKey: randomUUID(),
    });
    expect(swap.status).toBe(404);
    expect(swap.json).toEqual({ error: "not_found" });

    // User B cannot create manual transaction on A's account
    const badTx = await postJson(base, "/api/commands/accounts.manual_transaction", cookieB, {
      workspaceId: wsB,
      accountId: accountIdA,
      amount: "100.00",
      currency: "EUR",
      direction: "OUTFLOW",
      effectiveDate: "2024-01-01",
      description: "Bad",
      idempotencyKey: randomUUID(),
    });
    expect(badTx.status).toBe(404);

    // User B cannot create balance snapshot on A's account
    const badSnap = await postJson(base, "/api/commands/accounts.balance_snapshot", cookieB, {
      workspaceId: wsB,
      accountId: accountIdA,
      asOfDate: "2024-01-01",
      amount: "100.00",
      currency: "EUR",
      idempotencyKey: randomUUID(),
    });
    expect(badSnap.status).toBe(404);

    // User B cannot list A's manual transactions
    const listA = await getJson(base, `/api/accounts/${accountIdA}/manual_transactions?workspaceId=${wsB}`, cookieB);
    expect(listA.status).toBe(404);

    // User B cannot list A's balance snapshots
    const listSnap = await getJson(base, `/api/accounts/${accountIdA}/balance_snapshots?workspaceId=${wsB}`, cookieB);
    expect(listSnap.status).toBe(404);
  });

  it("handles values past JavaScript safe integer at JSON boundaries", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-acct-i");
    const createKey = randomUUID();
    const created = await postJson(base, "/api/commands/accounts.create", cookie, {
      workspaceId,
      name: "Big",
      currency: "EUR",
      idempotencyKey: createKey,
    });
    const accountId = (created.json as { id: string }).id;

    // Version past safe integer
    const { withTenant } = await import("../apps/web/src/tenancy.ts");
    const user = (await pool.query("SELECT id FROM users WHERE auth_subject = $1", ["e03-acct-i"])).rows[0].id as string;
    await withTenant(pool, { userId: user, workspaceId }, async (client) => {
      await client.query("UPDATE accounts SET version = '9007199254740993' WHERE workspace_id = $1 AND id = $2", [workspaceId, accountId]);
    });

    // Update with high version
    const updateKey = randomUUID();
    const updated = await postJson(base, "/api/commands/accounts.update", cookie, {
      workspaceId,
      accountId,
      expectedVersion: "9007199254740993",
      name: "Big Updated",
      idempotencyKey: updateKey,
    });
    expect(updated.status).toBe(200);
    const text = JSON.stringify(updated.json);
    expect(text).toContain('"version":"9007199254740994"');
    expect(text).not.toContain('"version":9007199254740994');
  });
});