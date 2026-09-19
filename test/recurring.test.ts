// E03-S07 recurring candidates + confirm/dismiss: pure detection goldens,
// versioned audited overrides, idempotent replay, tenant isolation, and the
// server-rendered page. Real PostgreSQL (`moneo_e03_recurring`, fails closed
// without PG); synthetic data only.

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

async function postForm(base: string, path: string, cookie: string, fields: Record<string, string>): Promise<{ status: number; text: string; location: string | null }> {
  const params = new URLSearchParams(fields);
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

async function seedRentSeries(workspaceId: string, userId: string, accountId: string): Promise<void> {
  await withTenant(pool, { userId, workspaceId }, async (client) => {
    const rows: [string, string][] = [
      ["2024-01-12", "Rent"],
      ["2024-02-11", "Rent"],
      ["2024-03-12", "rent  "],
    ];
    let n = 0;
    for (const [date, description] of rows) {
      n += 1;
      await client.query(
        "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        [workspaceId, randomUUID(), accountId, "80000", "EUR", "OUTFLOW", date, description, randomUUID(), n, randomUUID()],
      );
    }
    await client.query(
      "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [workspaceId, randomUUID(), accountId, "4200", "EUR", "OUTFLOW", "2024-03-01", "One-off", randomUUID(), 99, randomUUID()],
    );
  });
}

beforeAll(async () => {
  pool = await ensureTestPool("E03-S07", "moneo_e03_recurring", [
    "recurring_overrides",
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

describe("e03-s07 recurring candidates", () => {
  it("detects a monthly candidate and labels the singleton sparse", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-recur-a");
    const acct = await createAccount(base, cookie, workspaceId, "Cash");
    await seedRentSeries(workspaceId, userId, acct);

    const listed = await getJson(base, `/api/recurring?workspaceId=${workspaceId}`, cookie);
    expect(listed.status).toBe(200);
    const candidates = listed.json.candidates as {
      fingerprint: string;
      description: string;
      amountMinor: string;
      occurrences: number;
      status: string;
      warnings: string[];
      confirmVersion: string;
      confirmable: boolean;
    }[];
    const rent = candidates.find((c) => c.occurrences === 3)!;
    expect(rent).toMatchObject({ amountMinor: "80000", status: "candidate", confirmable: true, confirmVersion: "0" });
    expect(rent.warnings.join(" ")).toContain("verify-not-transfer");
    expect(rent.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const sparse = candidates.find((c) => c.description === "One-off")!;
    expect(sparse).toMatchObject({ status: "sparse", confirmable: false });

    // Sparse fingerprints cannot be confirmed.
    const noConfirm = await postJson(base, "/api/commands/recurring.confirm", cookie, {
      workspaceId,
      fingerprint: sparse.fingerprint,
      kind: "expense",
      dayOfMonth: 12,
      expectedVersion: "0",
      idempotencyKey: randomUUID(),
    });
    expect(noConfirm.status).toBe(404);
  });

  it("confirms with explicit kind, replays identically, and versions conflicts", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-recur-b");
    const acct = await createAccount(base, cookie, workspaceId, "Cash");
    await seedRentSeries(workspaceId, userId, acct);
    const rent = ((await getJson(base, `/api/recurring?workspaceId=${workspaceId}`, cookie)).json.candidates as { fingerprint: string; occurrences: number }[]).find((c) => c.occurrences === 3)!;

    const bookedBefore = await withTenant(pool, { userId, workspaceId }, async (client) => {
      const a = await client.query("SELECT COUNT(*) AS c FROM transactions WHERE workspace_id = $1", [workspaceId]);
      const b = await client.query("SELECT COUNT(*) AS c FROM manual_transactions WHERE workspace_id = $1", [workspaceId]);
      return Number((a.rows[0] as { c: string }).c) + Number((b.rows[0] as { c: string }).c);
    });

    const key = randomUUID();
    const confirmed = await postJson(base, "/api/commands/recurring.confirm", cookie, {
      workspaceId,
      fingerprint: rent.fingerprint,
      kind: "expense",
      dayOfMonth: 12,
      expectedVersion: "0",
      idempotencyKey: key,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json).toMatchObject({ status: "confirmed", kind: "expense", dayOfMonth: 12, version: "1", replayed: false });

    const replay = await postJson(base, "/api/commands/recurring.confirm", cookie, {
      workspaceId,
      fingerprint: rent.fingerprint,
      kind: "expense",
      dayOfMonth: 12,
      expectedVersion: "0",
      idempotencyKey: key,
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ replayed: true, version: "1" });
    expect((replay.json as { operationId: string }).operationId).toBe((confirmed.json as { operationId: string }).operationId);

    const stale = await postJson(base, "/api/commands/recurring.confirm", cookie, {
      workspaceId,
      fingerprint: rent.fingerprint,
      kind: "income",
      dayOfMonth: 1,
      expectedVersion: "0",
      idempotencyKey: randomUUID(),
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ reason: "version_mismatch", currentVersion: "1" });

    // Confirmation fabricates no booked rows; list shows the assumption.
    const bookedAfter = await withTenant(pool, { userId, workspaceId }, async (client) => {
      const a = await client.query("SELECT COUNT(*) AS c FROM transactions WHERE workspace_id = $1", [workspaceId]);
      const b = await client.query("SELECT COUNT(*) AS c FROM manual_transactions WHERE workspace_id = $1", [workspaceId]);
      return Number((a.rows[0] as { c: string }).c) + Number((b.rows[0] as { c: string }).c);
    });
    expect(bookedAfter).toBe(bookedBefore);
    const relisted = ((await getJson(base, `/api/recurring?workspaceId=${workspaceId}`, cookie)).json.candidates as {
      fingerprint: string;
      override: { status: string; kind: string } | null;
    }[]).find((c) => c.fingerprint === rent.fingerprint)!;
    expect(relisted.override).toMatchObject({ status: "confirmed", kind: "expense" });
    const audit = await withTenant(pool, { userId, workspaceId }, async (client) => {
      const r = await client.query("SELECT COUNT(*) AS c FROM audit_events WHERE workspace_id = $1 AND entity_type = 'recurring_candidate'", [workspaceId]);
      return Number((r.rows[0] as { c: string }).c);
    });
    expect(audit).toBeGreaterThan(0);
  });

  it("converges concurrent confirms to one winner and dismisses sparse series", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-recur-c");
    const acct = await createAccount(base, cookie, workspaceId, "Cash");
    await seedRentSeries(workspaceId, userId, acct);
    const all = ((await getJson(base, `/api/recurring?workspaceId=${workspaceId}`, cookie)).json.candidates as {
      fingerprint: string;
      occurrences: number;
      description: string;
    }[]);
    const rent = all.find((c) => c.occurrences === 3)!;
    const sparse = all.find((c) => c.description === "One-off")!;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        postJson(base, "/api/commands/recurring.confirm", cookie, {
          workspaceId,
          fingerprint: rent.fingerprint,
          kind: "expense",
          dayOfMonth: 12,
          expectedVersion: "0",
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBe(4);

    const dismissed = await postJson(base, "/api/commands/recurring.dismiss", cookie, {
      workspaceId,
      fingerprint: sparse.fingerprint,
      expectedVersion: "0",
      idempotencyKey: randomUUID(),
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.json).toMatchObject({ status: "dismissed", version: "1" });
  });

  it("converges a wide first-confirm race to one winner with zero 503s (B1)", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-recur-race");
    const acct = await createAccount(base, cookie, workspaceId, "Cash");
    await seedRentSeries(workspaceId, userId, acct);
    const rent = ((await getJson(base, `/api/recurring?workspaceId=${workspaceId}`, cookie)).json.candidates as { fingerprint: string; occurrences: number }[]).find((c) => c.occurrences === 3)!;
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        postJson(base, "/api/commands/recurring.confirm", cookie, {
          workspaceId,
          fingerprint: rent.fingerprint,
          kind: "expense",
          dayOfMonth: 12,
          expectedVersion: "0",
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBe(11);
    for (const r of results) expect(r.status).not.toBe(503);
    for (const r of results.filter((x) => x.status === 409)) expect(r.json.currentVersion).toBe("1");
  });

  it("keeps exact versions beyond safe integer at JSON boundaries (B2)", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-recur-big");
    const acct = await createAccount(base, cookie, workspaceId, "Cash");
    await seedRentSeries(workspaceId, userId, acct);
    const rent = ((await getJson(base, `/api/recurring?workspaceId=${workspaceId}`, cookie)).json.candidates as { fingerprint: string; occurrences: number }[]).find((c) => c.occurrences === 3)!;
    await withTenant(pool, { userId, workspaceId }, async (client) => {
      await client.query("INSERT INTO recurring_overrides (workspace_id, id, fingerprint, status, version) VALUES ($1, $2, $3, 'dismissed', $4)", [workspaceId, randomUUID(), rent.fingerprint, "9007199254740993"]);
    });
    const raw = await fetch(`${base}/api/recurring?workspaceId=${workspaceId}`, { headers: { cookie } }).then((r) => r.text());
    expect(raw).toContain('"version":"9007199254740993"');
    expect(raw).not.toMatch(/9007199254740993[^"]/);
    const confirmed = await postJson(base, "/api/commands/recurring.confirm", cookie, {
      workspaceId,
      fingerprint: rent.fingerprint,
      kind: "expense",
      dayOfMonth: 12,
      expectedVersion: "9007199254740993",
      idempotencyKey: randomUUID(),
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.version).toBe("9007199254740994");
  });

  it("rejects incompatible key reuse and leaves genuine refund pairs unmarked (B3)", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-recur-reuse");
    const acct = await createAccount(base, cookie, workspaceId, "Cash");
    await seedRentSeries(workspaceId, userId, acct);
    // Genuine opposite-direction pair: same description and amount, one
    // OUTFLOW and one INFLOW — must stay two sparse singletons, never one
    // pre-marked expense.
    await withTenant(pool, { userId, workspaceId }, async (client) => {
      for (const [date, direction] of [["2024-01-20", "OUTFLOW"], ["2024-01-21", "INFLOW"]] as const) {
        await client.query(
          "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
          [workspaceId, randomUUID(), acct, "7777", "EUR", direction, date, "Refund tango", randomUUID(), Math.floor(Math.random() * 1e9), randomUUID()],
        );
      }
    });
    const listed = ((await getJson(base, `/api/recurring?workspaceId=${workspaceId}`, cookie)).json.candidates as {
      fingerprint: string;
      description: string;
      status: string;
      override: unknown;
    }[]).filter((c) => c.description === "Refund tango");
    expect(listed).toHaveLength(2);
    for (const c of listed) {
      expect(c).toMatchObject({ status: "sparse", override: null });
      const attempt = await postJson(base, "/api/commands/recurring.confirm", cookie, {
        workspaceId,
        fingerprint: c.fingerprint,
        kind: "expense",
        dayOfMonth: 20,
        expectedVersion: "0",
        idempotencyKey: randomUUID(),
      });
      expect(attempt.status).toBe(404);
    }
    const rent = ((await getJson(base, `/api/recurring?workspaceId=${workspaceId}`, cookie)).json.candidates as { fingerprint: string; occurrences: number }[]).find((c) => c.occurrences === 3)!;
    const key = randomUUID();
    const first = await postJson(base, "/api/commands/recurring.confirm", cookie, {
      workspaceId,
      fingerprint: rent.fingerprint,
      kind: "expense",
      dayOfMonth: 12,
      expectedVersion: "0",
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    const reuse = await postJson(base, "/api/commands/recurring.confirm", cookie, {
      workspaceId,
      fingerprint: rent.fingerprint,
      kind: "income",
      dayOfMonth: 1,
      expectedVersion: "0",
      idempotencyKey: key,
    });
    expect(reuse.status).toBe(409);
    expect(reuse.json.reason).toBe("idempotency_reuse");
  });

  it("requires explicit kind for refund-like pairs and isolates tenants", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-recur-d");
    const other = await setupWorkspace(base, "e03-recur-e");
    const acct = await createAccount(base, cookie, workspaceId, "Cash");
    await withTenant(pool, { userId, workspaceId }, async (client) => {
      for (const [date, direction] of [["2024-01-05", "OUTFLOW"], ["2024-02-05", "OUTFLOW"], ["2024-03-05", "OUTFLOW"]] as const) {
        await client.query(
          "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
          [workspaceId, randomUUID(), acct, "9999", "EUR", direction, date, "Card purchase", randomUUID(), Math.floor(Math.random() * 1e9), randomUUID()],
        );
      }
    });
    const listed = ((await getJson(base, `/api/recurring?workspaceId=${workspaceId}`, cookie)).json.candidates as {
      kind?: string;
      override: unknown;
      warnings: string[];
    }[]);
    // Nothing is pre-marked expense: the override is null until the user
    // explicitly confirms a kind, and the warning names the check.
    expect(listed.length).toBeGreaterThan(0);
    for (const c of listed) expect(c.override).toBeNull();
    expect(listed[0].warnings.join(" ")).toContain("verify-not-transfer");

    const foreign = await getJson(base, `/api/recurring?workspaceId=${other.workspaceId}`, cookie);
    expect(foreign.status).toBe(404);
    const fp = "a".repeat(64);
    const crossConfirm = await postJson(base, "/api/commands/recurring.confirm", other.cookie, {
      workspaceId: other.workspaceId,
      fingerprint: fp,
      kind: "expense",
      dayOfMonth: 5,
      expectedVersion: "0",
      idempotencyKey: randomUUID(),
    });
    expect([404, 409]).toContain(crossConfirm.status);
    const unscoped = await pool.query("SELECT COUNT(*) AS c FROM recurring_overrides");
    expect(Number((unscoped.rows[0] as { c: string }).c)).toBe(0);
  });

  it("renders the page and drives confirm/dismiss forms with conflict honesty", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "e03-recur-f");
    const acct = await createAccount(base, cookie, workspaceId, "Cash");
    await seedRentSeries(workspaceId, userId, acct);

    const html = await getHtml(base, `/w/${workspaceId}/recurring`, cookie);
    expect(html.status).toBe(200);
    expect(html.text).toContain("Recurring candidates");
    expect(html.text).toContain("verify-not-transfer");
    expect(html.text).toContain("assumption");
    expect(html.text).not.toContain("<script");

    const rent = ((await getJson(base, `/api/recurring?workspaceId=${workspaceId}`, cookie)).json.candidates as { fingerprint: string; occurrences: number }[]).find((c) => c.occurrences === 3)!;
    const ok = await postForm(base, `/w/${workspaceId}/recurring/confirm`, cookie, {
      fingerprint: rent.fingerprint,
      expectedVersion: "0",
      kind: "expense",
      dayOfMonth: "12",
      idempotencyKey: randomUUID(),
    });
    expect(ok.status).toBe(303);
    expect(ok.location).toContain("notice=confirmed");

    const stale = await postForm(base, `/w/${workspaceId}/recurring/confirm`, cookie, {
      fingerprint: rent.fingerprint,
      expectedVersion: "0",
      kind: "income",
      dayOfMonth: "1",
      idempotencyKey: randomUUID(),
    });
    expect(stale.status).toBe(409);
    expect(stale.text).toContain("Schedule conflict");

    const badDay = await postForm(base, `/w/${workspaceId}/recurring/confirm`, cookie, {
      fingerprint: rent.fingerprint,
      expectedVersion: "1",
      kind: "expense",
      dayOfMonth: "31",
      idempotencyKey: randomUUID(),
    });
    expect(badDay.status).toBe(400);
  });
});
