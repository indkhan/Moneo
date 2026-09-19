// E03-S06 transaction table + drawer: shared reads, scoped filters,
// pagination/sort, per-currency totals, bulk edits, evidence, and the
// server-rendered journeys. Real PostgreSQL (`moneo_e03_txtable`, fails
// closed without PG); synthetic data only.

import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import type { Session } from "../apps/web/src/session-store.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
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
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
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

async function getJson(base: string, path: string, cookie: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  return { status: res.status, json: await res.json() };
}

async function getHtml(base: string, path: string, cookie: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  return { status: res.status, text: await res.text() };
}

async function postForm(base: string, path: string, cookie: string, fields: Record<string, string | string[]>): Promise<{ status: number; text: string; location: string | null }> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const item of v) params.append(k, item);
    else params.append(k, v);
  }
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, origin: base, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    redirect: "manual",
  });
  return { status: res.status, text: await res.text(), location: res.headers.get("location") };
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

async function insertImportedTx(
  workspaceId: string,
  userId: string,
  accountId: string,
  opts: { amountMinor?: string; direction?: string; date?: string; description?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await withTenant(pool, { userId, workspaceId }, async (client) => {
    await client.query(
      "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [workspaceId, id, accountId, opts.amountMinor ?? "10000", "EUR", opts.direction ?? "OUTFLOW", opts.date ?? "2024-01-15", opts.description ?? "Seeded", randomUUID(), Math.floor(Math.random() * 1e9), randomUUID()],
    );
  });
  return id;
}

async function createManualTx(base: string, cookie: string, workspaceId: string, accountId: string, description: string, date = "2024-01-16"): Promise<string> {
  const created = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
    workspaceId,
    accountId,
    amount: "25.00",
    currency: "EUR",
    direction: "INFLOW",
    effectiveDate: date,
    description,
    idempotencyKey: randomUUID(),
  });
  expect(created.status).toBe(200);
  return (created.json as { id: string }).id;
}

async function independentTotals(workspaceId: string, userId: string, accountId?: string): Promise<{ count: string; eurIn: string; eurOut: string }> {
  return withTenant(pool, { userId, workspaceId }, async (client) => {
    let count = 0n;
    let inflow = 0n;
    let outflow = 0n;
    for (const table of ["transactions", "manual_transactions"]) {
      const clause = accountId ? "workspace_id = $1 AND account_id = $2" : "workspace_id = $1";
      const params = accountId ? [workspaceId, accountId] : [workspaceId];
      const agg = await client.query(
        `SELECT COUNT(*) AS c, COALESCE(SUM(CASE WHEN direction = 'INFLOW' THEN amount_minor ELSE 0 END), 0) AS inflow, COALESCE(SUM(CASE WHEN direction = 'OUTFLOW' THEN amount_minor ELSE 0 END), 0) AS outflow FROM ${table} WHERE ${clause}`,
        params,
      );
      const a = agg.rows[0] as { c: string; inflow: string; outflow: string };
      count += BigInt(a.c);
      inflow += BigInt(a.inflow);
      outflow += BigInt(a.outflow);
    }
    return { count: count.toString(10), eurIn: inflow.toString(10), eurOut: outflow.toString(10) };
  });
}

beforeAll(async () => {
  pool = await ensureTestPool("E03-S06", "moneo_e03_txtable", [
    "transaction_tags",
    "audit_events",
    "tags",
    "categories",
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

describe("e03-s06 transaction table and drawer", () => {
  it("lists/filters/sorts/pages with exact per-currency totals matching independent SQL", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-table-a");
    const acctA = await createAccount(base, cookie, workspaceId, "Cash");
    const acctB = await createAccount(base, cookie, workspaceId, "Savings");
    await insertImportedTx(workspaceId, userId, acctA, { amountMinor: "10000", direction: "OUTFLOW", date: "2024-01-10", description: "Alpha market" });
    await insertImportedTx(workspaceId, userId, acctA, { amountMinor: "5000", direction: "OUTFLOW", date: "2024-01-12", description: "Beta fuel" });
    await insertImportedTx(workspaceId, userId, acctB, { amountMinor: "20000", direction: "INFLOW", date: "2024-01-11", description: "Gamma salary" });
    await createManualTx(base, cookie, workspaceId, acctA, "Delta refund", "2024-01-13");

    const all = await getJson(base, `/api/transactions?workspaceId=${workspaceId}&limit=100`, cookie);
    expect(all.status).toBe(200);
    expect(all.json.totals.count).toBe("4");
    const eur = (all.json.totals.byCurrency as { currency: string; count: string; inflowMinor: string; outflowMinor: string }[]).find((t) => t.currency === "EUR")!;
    // Inflow: 20000 (imported) + 2500 (manual 25.00) = 22500; outflow: 10000 + 5000 = 15000.
    expect(eur).toMatchObject({ count: "4", inflowMinor: "22500", outflowMinor: "15000" });
    const expected = await independentTotals(workspaceId, userId);
    expect(eur.count).toBe(expected.count);
    expect(eur.inflowMinor).toBe(expected.eurIn);
    expect(eur.outflowMinor).toBe(expected.eurOut);

    // Account filter + independent check.
    const scoped = await getJson(base, `/api/transactions?workspaceId=${workspaceId}&accountId=${acctA}&limit=100`, cookie);
    expect(scoped.json.totals.count).toBe("3");
    const scopedExpected = await independentTotals(workspaceId, userId, acctA);
    const scopedEur = (scoped.json.totals.byCurrency as typeof eur[])[0];
    expect(scopedEur.count).toBe(scopedExpected.count);

    // Sort asc + pagination: page 2 never repeats page 1.
    const p1 = await getJson(base, `/api/transactions?workspaceId=${workspaceId}&sort=date_asc&limit=2&offset=0`, cookie);
    const p2 = await getJson(base, `/api/transactions?workspaceId=${workspaceId}&sort=date_asc&limit=2&offset=2`, cookie);
    expect((p1.json.items as { id: string }[]).map((i) => i.id)).toHaveLength(2);
    expect((p2.json.items as { id: string }[]).map((i) => i.id)).toHaveLength(2);
    expect(new Set([...(p1.json.items as { id: string }[]), ...(p2.json.items as { id: string }[])].map((i) => i.id)).size).toBe(4);
    expect((p1.json.items as { effectiveDate: string }[])[0].effectiveDate).toBe("2024-01-10");

    // Search + direction filters.
    const search = await getJson(base, `/api/transactions?workspaceId=${workspaceId}&search=${encodeURIComponent("market")}&limit=100`, cookie);
    expect((search.json.items as unknown[])).toHaveLength(1);
    const inflowOnly = await getJson(base, `/api/transactions?workspaceId=${workspaceId}&direction=INFLOW&limit=100`, cookie);
    expect(inflowOnly.json.totals.count).toBe("2");

    // LIKE wildcards are escaped: a bare % matches nothing extra.
    const wild = await getJson(base, `/api/transactions?workspaceId=${workspaceId}&search=${encodeURIComponent("%")}&limit=100`, cookie);
    expect((wild.json.items as unknown[])).toHaveLength(0);

    // UI/API parity: same rows and totals line in HTML.
    const html = await getHtml(base, `/w/${workspaceId}/transactions?limit=100`, cookie);
    expect(html.status).toBe(200);
    expect(html.text).toContain("4 matching transactions");
    expect(html.text).toContain("Alpha market");
    expect(html.text).toContain("Delta refund");
    expect(html.text).not.toContain("<script");
  });

  it("keeps foreign and missing ids indistinguishable with zero unscoped rows", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "e03-table-b");
    const b = await setupWorkspace(base, "e03-table-c");
    const acctA = await createAccount(base, a.cookie, a.workspaceId, "Cash");
    const txId = await insertImportedTx(a.workspaceId, a.userId, acctA);

    const filtered = await getJson(base, `/api/transactions?workspaceId=${b.workspaceId}&accountId=${acctA}&limit=100`, b.cookie);
    expect(filtered.status).toBe(200);
    expect((filtered.json.items as unknown[])).toHaveLength(0);

    const direct = await getJson(base, `/api/transactions/${txId}?workspaceId=${b.workspaceId}&kind=imported`, b.cookie);
    expect(direct.status).toBe(404);
    expect(direct.json).toEqual({ error: "not_found" });
    const missing = await getJson(base, `/api/transactions/${randomUUID()}?workspaceId=${b.workspaceId}&kind=imported`, b.cookie);
    expect(missing.status).toBe(direct.status);
    expect(missing.json).toEqual(direct.json);

    const html = await getHtml(base, `/w/${b.workspaceId}/transactions`, b.cookie);
    expect(html.status).toBe(200);
    expect(html.text).toContain("No matching transactions");

    const unscoped = await pool.query("SELECT COUNT(*) AS c FROM transactions");
    expect(Number((unscoped.rows[0] as { c: string }).c)).toBe(0);
  });

  it("bulk set-category applies all-or-nothing with replay and per-item detail", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-bulk-a");
    const acct = await createAccount(base, cookie, workspaceId, "Cash");
    const t1 = await insertImportedTx(workspaceId, userId, acct, { description: "One" });
    const t2 = await insertImportedTx(workspaceId, userId, acct, { description: "Two" });
    const t3 = await insertImportedTx(workspaceId, userId, acct, { description: "Three" });
    const cat = (await postJson(base, "/api/commands/categories.create", cookie, { workspaceId, name: "Bulk", idempotencyKey: randomUUID() })).json as { id: string };

    const key = randomUUID();
    const stale = await postJson(base, "/api/commands/transactions.bulk_set_category", cookie, {
      workspaceId,
      transactionKind: "imported",
      categoryId: cat.id,
      items: [
        { transactionId: t1, expectedVersion: "1" },
        { transactionId: t2, expectedVersion: "1" },
        { transactionId: t3, expectedVersion: "999" },
      ],
      idempotencyKey: key,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.reason).toBe("version_mismatch");
    expect((stale.json.detail as { items: { transactionId: string }[] }).items.map((i) => i.transactionId)).toEqual([t3]);
    const untouched = await getJson(base, `/api/transactions/${t1}?workspaceId=${workspaceId}&kind=imported`, cookie);
    expect(untouched.json).toMatchObject({ categoryId: null, version: "1" });

    const okKey = randomUUID();
    const applied = await postJson(base, "/api/commands/transactions.bulk_set_category", cookie, {
      workspaceId,
      transactionKind: "imported",
      categoryId: cat.id,
      items: [
        { transactionId: t1, expectedVersion: "1" },
        { transactionId: t2, expectedVersion: "1" },
        { transactionId: t3, expectedVersion: "1" },
      ],
      idempotencyKey: okKey,
    });
    expect(applied.status).toBe(200);
    expect((applied.json.updated as { transactionId: string; version: string }[]).map((u) => u.version)).toEqual(["2", "2", "2"]);

    const replay = await postJson(base, "/api/commands/transactions.bulk_set_category", cookie, {
      workspaceId,
      transactionKind: "imported",
      categoryId: cat.id,
      items: [
        { transactionId: t1, expectedVersion: "1" },
        { transactionId: t2, expectedVersion: "1" },
        { transactionId: t3, expectedVersion: "1" },
      ],
      idempotencyKey: okKey,
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ replayed: true });
    expect((replay.json as { operationId: string }).operationId).toBe((applied.json as { operationId: string }).operationId);
    const still = await getJson(base, `/api/transactions/${t1}?workspaceId=${workspaceId}&kind=imported`, cookie);
    expect(still.json.version).toBe("2");
  });

  it("converges a bulk batch racing a single correction to one winner", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-bulkrace-a");
    const acct = await createAccount(base, cookie, workspaceId, "Cash");
    const t1 = await insertImportedTx(workspaceId, userId, acct, { description: "Racy" });
    const cat = (await postJson(base, "/api/commands/categories.create", cookie, { workspaceId, name: "Race", idempotencyKey: randomUUID() })).json as { id: string };
    const [bulk, single] = await Promise.all([
      postJson(base, "/api/commands/transactions.bulk_set_category", cookie, {
        workspaceId,
        transactionKind: "imported",
        categoryId: cat.id,
        items: [{ transactionId: t1, expectedVersion: "1" }],
        idempotencyKey: randomUUID(),
      }),
      postJson(base, "/api/commands/transactions.correct", cookie, {
        workspaceId,
        transactionKind: "imported",
        transactionId: t1,
        expectedVersion: "1",
        description: "Single winner?",
        idempotencyKey: randomUUID(),
      }),
    ]);
    const winners = [bulk, single].filter((r) => r.status === 200);
    const losers = [bulk, single].filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const view = await getJson(base, `/api/transactions/${t1}?workspaceId=${workspaceId}&kind=imported`, cookie);
    expect(view.json.version).toBe("2");
  });

  it("exposes source evidence for imported and manual transactions", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-evidence-a");
    const acct = await createAccount(base, cookie, workspaceId, "Cash");
    const txId = await insertImportedTx(workspaceId, userId, acct, { description: "Evidence" });
    await withTenant(pool, { userId, workspaceId }, async (client) => {
      const dsId = randomUUID();
      const importId = randomUUID();
      await client.query("INSERT INTO data_sources (workspace_id, id, type, name, status) VALUES ($1, $2, 'csv_upload', 'stmt.csv', 'ACTIVE')", [workspaceId, dsId]);
      await client.query(
        "INSERT INTO imports (workspace_id, id, data_source_id, idempotency_key, file_name, file_sha256, object_key, parser_version, status) VALUES ($1, $2, $3, $4, 'stmt.csv', $5, 'q/stmt.csv', 'test-1', 'STAGED')",
        [workspaceId, importId, dsId, `ev-${importId}`, "1".repeat(64)],
      );
      await client.query("UPDATE transactions SET import_id = $1, import_row_no = 3, observation_id = 'obs-3' WHERE workspace_id = $2 AND id = $3", [importId, workspaceId, txId]);
      await client.query("INSERT INTO source_links (workspace_id, id, import_id, import_row_no, observation_id, target_transaction_id, status, match_reason) VALUES ($1, $2, $3, 3, 'obs-3', $4, 'MATCHED', 'exact-match')", [
        workspaceId,
        randomUUID(),
        importId,
        txId,
      ]);
    });
    const evidence = await getJson(base, `/api/transactions/${txId}/evidence?workspaceId=${workspaceId}&kind=imported`, cookie);
    expect(evidence.status).toBe(200);
    expect(evidence.json.source).toMatchObject({ kind: "imported", fileName: "stmt.csv", importRowNo: 3, observationId: "obs-3", linkStatus: "MATCHED", matchReason: "exact-match" });

    const manualId = await createManualTx(base, cookie, workspaceId, acct, "Manual evidence");
    const manualEvidence = await getJson(base, `/api/transactions/${manualId}/evidence?workspaceId=${workspaceId}&kind=manual`, cookie);
    expect(manualEvidence.json.source).toMatchObject({ kind: "manual", reference: null });

    const drawer = await getHtml(base, `/w/${workspaceId}/transactions/${txId}?kind=imported`, cookie);
    expect(drawer.status).toBe(200);
    expect(drawer.text).toContain("stmt.csv");
    expect(drawer.text).toContain("MATCHED");
    expect(drawer.text).toContain("Save category");
  });

  it("keeps exact versions beyond safe integer and renders drawer conflicts with preserved input", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-drawer-a");
    const acct = await createAccount(base, cookie, workspaceId, "Cash");
    const txId = await insertImportedTx(workspaceId, userId, acct, { description: "Big" });
    await withTenant(pool, { userId, workspaceId }, async (client) => {
      await client.query("UPDATE transactions SET version = $1 WHERE workspace_id = $2 AND id = $3", ["9007199254740993", workspaceId, txId]);
    });
    const list = await getJson(base, `/api/transactions?workspaceId=${workspaceId}&limit=100`, cookie);
    expect(JSON.stringify(list.json)).toContain('"version":"9007199254740993"');

    // Stale drawer form: 409 shell preserves the submitted description.
    const conflict = await postForm(base, `/w/${workspaceId}/transactions/${txId}/correct`, cookie, {
      kind: "imported",
      expectedVersion: "1",
      description: "Preserve me",
      idempotencyKey: randomUUID(),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.text).toContain("Update conflict");
    expect(conflict.text).toContain("Preserve me");

    // Fresh drawer form succeeds and redirects to the table notice.
    const ok = await postForm(base, `/w/${workspaceId}/transactions/${txId}/correct`, cookie, {
      kind: "imported",
      expectedVersion: "9007199254740993",
      description: "Fresh win",
      idempotencyKey: randomUUID(),
    });
    expect(ok.status).toBe(303);
    expect(ok.location).toContain("notice=corrected");
  });

  it("renders labelled, keyboard-usable table journeys at structural level", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-a11y-a");
    const acct = await createAccount(base, cookie, workspaceId, "Cash");
    await insertImportedTx(workspaceId, userId, acct, { description: "Accessible" });
    const html = await getHtml(base, `/w/${workspaceId}/transactions`, cookie);
    expect(html.status).toBe(200);
    expect(html.text).toContain('lang="en"');
    expect(html.text).toContain('href="#main"');
    expect(html.text).toContain("<caption>Transactions");
    expect(html.text).toContain('scope="col"');
    expect(html.text).toContain("<label>");
    expect(html.text).toContain("selection applies to this page only");
    expect(html.text).not.toContain("<script");
    // Bulk validation error preserves navigation (no data loss, honest 400).
    const empty = await postForm(base, `/w/${workspaceId}/transactions/bulk`, cookie, {
      categoryId: "__clear__",
      idempotencyKey: randomUUID(),
    });
    expect(empty.status).toBe(400);
    expect(empty.text).toContain("Nothing to update");
  });
});
