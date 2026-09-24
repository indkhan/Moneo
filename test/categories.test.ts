// E03-S05 categories/tags, correction, audit and supported undo.
// Real PostgreSQL (`moneo_e03_categories`, fails closed without PG);
// synthetic users, workspaces, accounts and transactions only.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { classifyLeg } from "../apps/web/src/calculations/cash.ts";
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

async function createAccount(base: string, cookie: string, workspaceId: string, name: string): Promise<string> {
  const created = await postJson(base, "/api/commands/accounts.create", cookie, {
    workspaceId,
    name,
    currency: "EUR",
    idempotencyKey: randomUUID(),
  });
  expect(created.status).toBe(200);
  return (created.json as { id: string }).id;
}

async function insertImportedTx(workspaceId: string, userId: string, accountId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await withTenant(pool, { userId, workspaceId }, async (client) => {
    await client.query(
      "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [
        workspaceId,
        id,
        accountId,
        overrides.amountMinor ?? "10000",
        overrides.currency ?? "EUR",
        overrides.direction ?? "OUTFLOW",
        overrides.effectiveDate ?? "2024-01-15",
        overrides.description ?? "Grocery",
        overrides.importId ?? randomUUID(),
        overrides.importRowNo ?? Math.floor(Math.random() * 1e9),
        overrides.observationId ?? randomUUID(),
      ],
    );
  });
  return id;
}

beforeAll(async () => {
  pool = await ensureTestPool("E03-S05", "moneo_e03_categories_v2", [
    "transaction_tags",
    "audit_events",
    "tags",
    "categories",
    // system_categories intentionally not truncated: global seed must survive.
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

describe("e03-s05 categories, tags, correction, audit, undo", () => {
  it("creates/lists/archives categories, reads system taxonomy, assigns with version + audit", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-cat-a");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    const txId = await insertImportedTx(workspaceId, userId, accountId);

    const sys = await getJson(base, `/api/system-categories`, cookie);
    expect(sys.status).toBe(200);
    expect((sys.json.categories as { code: string }[]).map((c) => c.code)).toEqual(
      expect.arrayContaining(["FOOD", "TRANSFER", "INCOME"]),
    );

    const created = await postJson(base, "/api/commands/categories.create", cookie, {
      workspaceId,
      name: "Groceries",
      idempotencyKey: randomUUID(),
    });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ workspaceId, name: "Groceries", parentId: null, archivedAt: null, replayed: false });
    const categoryId = (created.json as { id: string }).id;

    const listed = await getJson(base, `/api/categories?workspaceId=${workspaceId}`, cookie);
    expect(listed.status).toBe(200);
    expect((listed.json.categories as { id: string }[]).map((c) => c.id)).toContain(categoryId);

    const assigned = await postJson(base, "/api/commands/transactions.set_category", cookie, {
      workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      categoryId,
      expectedVersion: "1",
      idempotencyKey: randomUUID(),
    });
    expect(assigned.status).toBe(200);
    expect(assigned.json).toMatchObject({ categoryId, version: "2", replayed: false });

    const audit = await getJson(base, `/api/audit/${txId}?workspaceId=${workspaceId}&entityType=transaction`, cookie);
    expect(audit.status).toBe(200);
    expect((audit.json.audit as { action: string }[]).length).toBe(1);
    expect(audit.json.audit[0]).toMatchObject({ action: "set_category", operationId: assigned.json.operationId });

    const archived = await postJson(base, "/api/commands/categories.archive", cookie, {
      workspaceId,
      categoryId,
      idempotencyKey: randomUUID(),
    });
    expect(archived.status).toBe(200);
    expect((archived.json as { archivedAt: string | null }).archivedAt).not.toBeNull();
    const listedAfter = await getJson(base, `/api/categories?workspaceId=${workspaceId}`, cookie);
    expect((listedAfter.json.categories as { id: string }[]).map((c) => c.id)).not.toContain(categoryId);
  });

  it("creates/tags add/remove with normalization, idempotent replay and audit", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-tag-a");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    const txId = await insertImportedTx(workspaceId, userId, accountId);

    const tag = await postJson(base, "/api/commands/tags.create", cookie, {
      workspaceId,
      name: "  Holiday  ",
      idempotencyKey: randomUUID(),
    });
    expect(tag.status).toBe(200);
    expect(tag.json).toMatchObject({ normalizedName: "holiday", archivedAt: null });
    const tagId = (tag.json as { id: string }).id;

    const dupe = await postJson(base, "/api/commands/tags.create", cookie, {
      workspaceId,
      name: "HOLIDAY",
      idempotencyKey: randomUUID(),
    });
    expect(dupe.status).toBe(409);
    expect(dupe.json).toEqual({ error: "conflict", reason: "idempotency_reuse" });

    const key = randomUUID();
    const added = await postJson(base, "/api/commands/transactions.add_tag", cookie, {
      workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      tagId,
      expectedVersion: "1",
      idempotencyKey: key,
    });
    expect(added.status).toBe(200);
    expect(added.json.tagIds).toEqual([tagId]);
    expect(added.json.version).toBe("2");

    const removed = await postJson(base, "/api/commands/transactions.remove_tag", cookie, {
      workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      tagId,
      expectedVersion: "2",
      idempotencyKey: randomUUID(),
    });
    expect(removed.status).toBe(200);
    expect(removed.json.tagIds).toEqual([]);
    expect(removed.json.version).toBe("3");

    const audit = await getJson(base, `/api/audit/${txId}?workspaceId=${workspaceId}&entityType=transaction`, cookie);
    expect((audit.json.audit as { action: string }[]).map((a) => a.action)).toEqual(["add_tag", "remove_tag"]);
  });

  it("corrects fields with optimistic versions, preserves audit, and replays idempotently", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-correct-a");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    const txId = await insertImportedTx(workspaceId, userId, accountId, { description: "Old", effectiveDate: "2024-01-10" });

    const key = randomUUID();
    const fixed = await postJson(base, "/api/commands/transactions.correct", cookie, {
      workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      expectedVersion: "1",
      amount: "123.45",
      currency: "EUR",
      direction: "OUTFLOW",
      description: "New",
      idempotencyKey: key,
    });
    expect(fixed.status).toBe(200);
    expect(fixed.json).toMatchObject({ amountMinor: "12345", currency: "EUR", description: "New", version: "2" });

    const replay = await postJson(base, "/api/commands/transactions.correct", cookie, {
      workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      expectedVersion: "1",
      amount: "123.45",
      currency: "EUR",
      direction: "OUTFLOW",
      description: "New",
      idempotencyKey: key,
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ replayed: true, version: "2" });
    expect((replay.json as { operationId: string }).operationId).toBe((fixed.json as { operationId: string }).operationId);

    const stale = await postJson(base, "/api/commands/transactions.correct", cookie, {
      workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      expectedVersion: "1",
      description: "Stale",
      idempotencyKey: randomUUID(),
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({ error: "conflict", reason: "version_mismatch", currentVersion: "2" });

    const audit = await getJson(base, `/api/audit/${txId}?workspaceId=${workspaceId}&entityType=transaction`, cookie);
    expect((audit.json.audit as unknown[]).length).toBe(1);
    expect(audit.json.audit[0].beforeState.description).toBe("Old");
    expect(audit.json.audit[0].afterState.description).toBe("New");
  });

  it("concurrent corrections converge to one winner without partial writes", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-race-a");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    const txId = await insertImportedTx(workspaceId, userId, accountId);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        postJson(base, "/api/commands/transactions.correct", cookie, {
          workspaceId,
          transactionKind: "imported",
          transactionId: txId,
          expectedVersion: "1",
          description: `Racer ${i}`,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBe(4);
    const view = await getJson(base, `/api/transactions/${txId}?workspaceId=${workspaceId}&kind=imported`, cookie);
    expect(view.json.version).toBe("2");
  });

  it("undoes a supported correction and conflicts when the object moved on", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-undo-a");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    const txId = await insertImportedTx(workspaceId, userId, accountId, { description: "Original" });

    const fixed = await postJson(base, "/api/commands/transactions.correct", cookie, {
      workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      expectedVersion: "1",
      description: "Corrected",
      idempotencyKey: randomUUID(),
    });
    expect(fixed.status).toBe(200);
    const opId = (fixed.json as { operationId: string }).operationId;

    const undone = await postJson(base, "/api/commands/operations.undo", cookie, {
      workspaceId,
      operationId: opId,
      idempotencyKey: randomUUID(),
    });
    expect(undone.status).toBe(200);
    expect(undone.json).toMatchObject({ description: "Original", version: "3" });

    const audit = await getJson(base, `/api/audit/${txId}?workspaceId=${workspaceId}&entityType=transaction`, cookie);
    const actions = (audit.json.audit as { action: string; compensatingOperationId: string | null }[]).map((a) => a.action);
    expect(actions).toEqual(["correct", "undo"]);
    expect(audit.json.audit[1].compensatingOperationId).toBe(opId);

    const conflict = await postJson(base, "/api/commands/operations.undo", cookie, {
      workspaceId,
      operationId: opId,
      idempotencyKey: randomUUID(),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.reason).toBe("undo_conflict");

    const catOp = await postJson(base, "/api/commands/categories.create", cookie, {
      workspaceId,
      name: "NoUndo",
      idempotencyKey: randomUUID(),
    });
    const unsupported = await postJson(base, "/api/commands/operations.undo", cookie, {
      workspaceId,
      operationId: (catOp.json as { operationId: string }).operationId,
      idempotencyKey: randomUUID(),
    });
    expect(unsupported.status).toBe(409);
    expect(unsupported.json.reason).toBe("unsupported_undo");
  });

  it("survives reimport: category/tag corrections and audit are not overwritten", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-reimport-a");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    const importId = randomUUID();
    const txId = await insertImportedTx(workspaceId, userId, accountId, { importId, importRowNo: 7, observationId: "obs-7" });

    const cat = await postJson(base, "/api/commands/categories.create", cookie, {
      workspaceId,
      name: "Kept",
      idempotencyKey: randomUUID(),
    });
    const categoryId = (cat.json as { id: string }).id;
    const assigned = await postJson(base, "/api/commands/transactions.set_category", cookie, {
      workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      categoryId,
      expectedVersion: "1",
      idempotencyKey: randomUUID(),
    });
    expect(assigned.status).toBe(200);

    // Simulate the E02 second-import path: DO NOTHING re-insert + link upsert.
    await withTenant(pool, { userId, workspaceId }, async (client) => {
      const dsId = randomUUID();
      await client.query(
        "INSERT INTO data_sources (workspace_id, id, type, name, status) VALUES ($1, $2, 'csv_upload', 'reimport.csv', 'ACTIVE') ON CONFLICT DO NOTHING",
        [workspaceId, dsId],
      );
      await client.query(
        "INSERT INTO imports (workspace_id, id, data_source_id, idempotency_key, file_name, file_sha256, object_key, parser_version, status) VALUES ($1, $2, $3, $4, 'reimport.csv', $5, 'q/reimport.csv', 'test-1', 'STAGED') ON CONFLICT DO NOTHING",
        [workspaceId, importId, dsId, `reimport-${importId}`, "0".repeat(64)],
      );
      await client.query(
        "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (workspace_id, import_id, import_row_no) DO NOTHING",
        [workspaceId, randomUUID(), accountId, "10000", "EUR", "OUTFLOW", "2024-01-15", "Grocery", importId, 7, "obs-7"],
      );
      await client.query(
        "INSERT INTO source_links (workspace_id, id, import_id, import_row_no, observation_id, target_transaction_id, status) VALUES ($1, $2, $3, $4, $5, $6, 'MATCHED') ON CONFLICT (workspace_id, import_id, import_row_no) DO UPDATE SET status = EXCLUDED.status, target_transaction_id = EXCLUDED.target_transaction_id",
        [workspaceId, randomUUID(), importId, 7, "obs-7", txId],
      );
    });

    const view = await getJson(base, `/api/transactions/${txId}?workspaceId=${workspaceId}&kind=imported`, cookie);
    expect(view.json).toMatchObject({ categoryId, version: "2" });
    const audit = await getJson(base, `/api/audit/${txId}?workspaceId=${workspaceId}&entityType=transaction`, cookie);
    expect((audit.json.audit as unknown[]).length).toBe(1);
  });

  it("isolates tenants and leaks no distinctions for foreign ids", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "e03-tenant-a");
    const b = await setupWorkspace(base, "e03-tenant-b");
    const accountId = await createAccount(base, a.cookie, a.workspaceId, "Cash");
    const txId = await insertImportedTx(a.workspaceId, a.userId, accountId);
    const cat = await postJson(base, "/api/commands/categories.create", a.cookie, {
      workspaceId: a.workspaceId,
      name: "Private",
      idempotencyKey: randomUUID(),
    });
    const categoryId = (cat.json as { id: string }).id;

    const foreignTx = await getJson(base, `/api/transactions/${txId}?workspaceId=${b.workspaceId}&kind=imported`, b.cookie);
    expect(foreignTx.status).toBe(404);
    expect(foreignTx.json).toEqual({ error: "not_found" });

    const foreignSet = await postJson(base, "/api/commands/transactions.set_category", b.cookie, {
      workspaceId: b.workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      categoryId,
      expectedVersion: "1",
      idempotencyKey: randomUUID(),
    });
    expect(foreignSet.status).toBe(404);
    expect(foreignSet.json).toEqual({ error: "not_found" });

    const foreignCat = await getJson(base, `/api/categories?workspaceId=${b.workspaceId}`, b.cookie);
    expect((foreignCat.json.categories as { id: string }[]).map((c) => c.id)).not.toContain(categoryId);

    const missing = await getJson(base, `/api/transactions/${randomUUID()}?workspaceId=${b.workspaceId}&kind=imported`, b.cookie);
    expect(missing.status).toBe(foreignTx.status);
    expect(missing.json).toEqual(foreignTx.json);

    // Unscoped app-role reads return zero tenant rows.
    const unscoped = await pool.query("SELECT COUNT(*) AS c FROM categories");
    expect(Number((unscoped.rows[0] as { c: string }).c)).toBe(0);
    const unscopedTags = await pool.query("SELECT COUNT(*) AS c FROM transaction_tags");
    expect(Number((unscopedTags.rows[0] as { c: string }).c)).toBe(0);
  });

  it("keeps exact decimal-string versions beyond safe integer at JSON boundaries", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-bigint-a");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    const txId = await insertImportedTx(workspaceId, userId, accountId);
    await withTenant(pool, { userId, workspaceId }, async (client) => {
      await client.query("UPDATE transactions SET version = $1 WHERE workspace_id = $2 AND id = $3", ["9007199254740993", workspaceId, txId]);
    });
    const raw = await getRaw(base, `/api/transactions/${txId}?workspaceId=${workspaceId}&kind=imported`, cookie);
    expect(raw.status).toBe(200);
    expect(raw.text).toContain('"version":"9007199254740993"');
    expect(raw.text).not.toContain("9007199254740993,");

    const cat = await postJson(base, "/api/commands/categories.create", cookie, {
      workspaceId,
      name: "Big",
      idempotencyKey: randomUUID(),
    });
    const moved = await postJson(base, "/api/commands/transactions.set_category", cookie, {
      workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      categoryId: (cat.json as { id: string }).id,
      expectedVersion: "9007199254740993",
      idempotencyKey: randomUUID(),
    });
    expect(moved.status).toBe(200);
    expect(moved.json.version).toBe("9007199254740994");
  });

  it("converges concurrent duplicate tag creation without 503s (B1)", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-tagrace-a");
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        postJson(base, "/api/commands/tags.create", cookie, {
          workspaceId,
          name: "Racy",
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBe(1);
    for (const r of results) expect(r.status).not.toBe(503);
    expect(results.find((r) => r.status === 409)!.json).toEqual({ error: "conflict", reason: "idempotency_reuse" });
  });

  it("converges parallel add_tag on one version to a single winner (B2)", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-addrace-a");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    const txId = await insertImportedTx(workspaceId, userId, accountId);
    const tag = await postJson(base, "/api/commands/tags.create", cookie, {
      workspaceId,
      name: "Shared",
      idempotencyKey: randomUUID(),
    });
    const tagId = (tag.json as { id: string }).id;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        postJson(base, "/api/commands/transactions.add_tag", cookie, {
          workspaceId,
          transactionKind: "imported",
          transactionId: txId,
          tagId,
          expectedVersion: "1",
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBe(4);
    for (const r of results) expect(r.status).not.toBe(503);
    const view = await getJson(base, `/api/transactions/${txId}?workspaceId=${workspaceId}&kind=imported`, cookie);
    expect(view.json).toMatchObject({ version: "2", tagIds: [tagId] });
  });

  it("refuses undo that would resurrect archived taxonomy (N1)", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-undoarch-a");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    const txId = await insertImportedTx(workspaceId, userId, accountId);
    const cat = await postJson(base, "/api/commands/categories.create", cookie, {
      workspaceId,
      name: "Doomed",
      idempotencyKey: randomUUID(),
    });
    const categoryId = (cat.json as { id: string }).id;
    const assigned = await postJson(base, "/api/commands/transactions.set_category", cookie, {
      workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      categoryId,
      expectedVersion: "1",
      idempotencyKey: randomUUID(),
    });
    expect(assigned.status).toBe(200);
    const cleared = await postJson(base, "/api/commands/transactions.set_category", cookie, {
      workspaceId,
      transactionKind: "imported",
      transactionId: txId,
      categoryId: null,
      expectedVersion: "2",
      idempotencyKey: randomUUID(),
    });
    expect(cleared.status).toBe(200);
    const archived = await postJson(base, "/api/commands/categories.archive", cookie, {
      workspaceId,
      categoryId,
      idempotencyKey: randomUUID(),
    });
    expect(archived.status).toBe(200);
    const undone = await postJson(base, "/api/commands/operations.undo", cookie, {
      workspaceId,
      operationId: (cleared.json as { operationId: string }).operationId,
      idempotencyKey: randomUUID(),
    });
    expect(undone.status).toBe(409);
    expect(undone.json.reason).toBe("undo_conflict");
  });

  it("rejects whitespace-only category names and manual-transaction tags honestly (B3/N3)", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-honest-a");
    const blank = await postJson(base, "/api/commands/categories.create", cookie, {
      workspaceId,
      name: "   ",
      idempotencyKey: randomUUID(),
    });
    expect(blank.status).toBe(400);
    expect(blank.json).toEqual({ error: "invalid_request" });

    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    const manual = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId,
      amount: "10.00",
      currency: "EUR",
      direction: "OUTFLOW",
      effectiveDate: "2024-02-01",
      description: "Manual",
      idempotencyKey: randomUUID(),
    });
    const tag = await postJson(base, "/api/commands/tags.create", cookie, {
      workspaceId,
      name: "ManualTag",
      idempotencyKey: randomUUID(),
    });
    const manualTag = await postJson(base, "/api/commands/transactions.add_tag", cookie, {
      workspaceId,
      transactionKind: "manual",
      transactionId: (manual.json as { id: string }).id,
      tagId: (tag.json as { id: string }).id,
      expectedVersion: "1",
      idempotencyKey: randomUUID(),
    });
    expect(manualTag.status).toBe(400);
    expect(manualTag.json).toEqual({ error: "invalid_request", reason: "unsupported_operation" });
  });

  it("corrects manual transactions and preserves transfer classification across category edits", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e03-manual-a");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    const manual = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
      workspaceId,
      accountId,
      amount: "50.00",
      currency: "EUR",
      direction: "OUTFLOW",
      effectiveDate: "2024-02-01",
      description: "Manual",
      idempotencyKey: randomUUID(),
    });
    expect(manual.status).toBe(200);
    const manualId = (manual.json as { id: string }).id;

    const cat = await postJson(base, "/api/commands/categories.create", cookie, {
      workspaceId,
      name: "ManualCat",
      idempotencyKey: randomUUID(),
    });
    const owned = new Set([accountId, "counterparty-owned"]);
    const before = classifyLeg(
      { accountId, amountMinor: 5000n, currency: "EUR", direction: "OUTFLOW", effectiveDate: "2024-02-01", description: "Manual", source: "manual", counterpartyAccountId: "counterparty-owned" },
      owned,
    );
    const set = await postJson(base, "/api/commands/transactions.correct", cookie, {
      workspaceId,
      transactionKind: "manual",
      transactionId: manualId,
      expectedVersion: "1",
      description: "Manual corrected",
      categoryId: (cat.json as { id: string }).id,
      idempotencyKey: randomUUID(),
    });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ description: "Manual corrected", version: "2" });
    const after = classifyLeg(
      { accountId, amountMinor: 5000n, currency: "EUR", direction: "OUTFLOW", effectiveDate: "2024-02-01", description: "Manual corrected", source: "manual", counterpartyAccountId: "counterparty-owned" },
      owned,
    );
    expect(after.classification).toBe(before.classification);
  });
});
