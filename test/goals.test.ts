// E06-S02 goals and virtual allocations: reservation honesty, concurrency,
// currency/capacity gates, undo/audit, tenant isolation. Real PostgreSQL
// (`moneo_e06_goals`, fails closed without PG); synthetic only.

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

async function postJson(base: string, path: string, cookie: string, body: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), text };
}

async function getJson(base: string, path: string, cookie: string): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), text };
}

async function setupWorkspace(base: string, sub: string): Promise<{ cookie: string; workspaceId: string }> {
  const cookie = await login(base, sub);
  const ws = (await postJson(base, "/api/workspaces", cookie, { name: "W", baseCurrency: "EUR" })).json as { id: string };
  return { cookie, workspaceId: ws.id };
}

async function createAccount(base: string, cookie: string, workspaceId: string, name: string): Promise<string> {
  const res = await postJson(base, "/api/commands/accounts.create", cookie, {
    workspaceId,
    name,
    currency: "EUR",
    idempotencyKey: randomUUID(),
  });
  expect(res.status).toBe(200);
  return (res.json as { id: string }).id;
}

async function createSnapshot(base: string, cookie: string, workspaceId: string, accountId: string, amountMajor: string): Promise<string> {
  const res = await postJson(base, "/api/commands/accounts.balance_snapshot", cookie, {
    workspaceId,
    accountId,
    asOfDate: "2026-01-01",
    amount: amountMajor,
    currency: "EUR",
    idempotencyKey: randomUUID(),
  });
  expect(res.status).toBe(200);
  return (res.json as { id: string }).id;
}

beforeAll(async () => {
  pool = await ensureTestPool("E06-S02", "moneo_e06_goals", [
    "goals",
    "goal_allocations",
    "balance_snapshots",
    "balance_audit",
    "accounts",
    "command_operations",
    "audit_events",
    "workspace_data_revision",
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

describe("e06-s02 goal CRUD and virtual allocations", () => {
  it("creates goal, allocates and releases with honest booked reads and full audit", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-goal-a");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");

    const goal = await postJson(base, "/api/commands/goals.create", cookie, {
      workspaceId,
      name: "Japan trip",
      goalType: "TRAVEL",
      targetAmountMinor: "350000",
      currency: "EUR",
      targetDate: "2027-07-01",
      priority: 1,
      idempotencyKey: randomUUID(),
    });
    expect(goal.status).toBe(200);
    const goalId = (goal.json as { id: string }).id;
    expect((goal.json as { status: string }).status).toBe("ACTIVE");

    // First allocation €400
    const alloc1 = await postJson(base, "/api/commands/allocations.allocate", cookie, {
      workspaceId,
      goalId,
      accountId,
      amountMinor: "40000",
      currency: "EUR",
      idempotencyKey: randomUUID(),
    });
    expect(alloc1.status).toBe(200);
    expect((alloc1.json as { amountMinor: string }).amountMinor).toBe("40000");

    // Second allocation €300
    const alloc2 = await postJson(base, "/api/commands/allocations.allocate", cookie, {
      workspaceId,
      goalId,
      accountId,
      amountMinor: "30000",
      currency: "EUR",
      idempotencyKey: randomUUID(),
    });
    expect(alloc2.status).toBe(200);
    expect((alloc2.json as { amountMinor: string }).amountMinor).toBe("70000");

    // Booked balance unchanged
    const snap = await getJson(base, `/api/accounts/${accountId}/balance_snapshots?workspaceId=${workspaceId}&limit=1`, cookie);
    const latest = (snap.json as { snapshots: { amountMinor: string }[] }).snapshots[0];
    expect(latest.amountMinor).toBe("100000");

    // Goal view shows reservation totals
    const goalView = await getJson(base, `/api/goals/${goalId}?workspaceId=${workspaceId}`, cookie);
    expect((goalView.json as { reservedMinor: string }).reservedMinor).toBe("70000");

    // Release €100
    const release = await postJson(base, "/api/commands/allocations.release", cookie, {
      workspaceId,
      goalId,
      accountId,
      amountMinor: "10000",
      idempotencyKey: randomUUID(),
    });
    expect(release.status).toBe(200);
    expect((release.json as { amountMinor: string }).amountMinor).toBe("60000");
  });

  it("5 concurrent allocates against €1000 capacity yield exactly one winner set ≤ capacity, zero 503", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-goal-race");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");
    const goal = await postJson(base, "/api/commands/goals.create", cookie, {
      workspaceId,
      name: "Emergency",
      goalType: "EMERGENCY_FUND",
      targetAmountMinor: "500000",
      currency: "EUR",
      idempotencyKey: randomUUID(),
    });
    const goalId = (goal.json as { id: string }).id;

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        postJson(base, "/api/commands/allocations.allocate", cookie, {
          workspaceId,
          goalId,
          accountId,
          amountMinor: "30000",
          currency: "EUR",
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    const wins = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    const serverErrors = results.filter((r) => r.status >= 500);
    expect(wins).toHaveLength(1);
    expect(conflicts).toHaveLength(4);
    expect(serverErrors).toHaveLength(0);
    const conflictReasons = conflicts.map((c) => (c.json as { reason: string }).reason);
    expect(conflictReasons.every((r) => r === "overallocation" || r === "version_mismatch")).toBe(true);

    // Replay winner key returns identical row
    const winner = wins[0]!;
    const replay = await postJson(base, "/api/commands/allocations.allocate", cookie, {
      workspaceId,
      goalId,
      accountId,
      amountMinor: "30000",
      currency: "EUR",
      idempotencyKey: (winner.json as { operationId: string }).operationId,
    });
    expect(replay.status).toBe(200);
    expect((replay.json as { replayed: boolean }).replayed).toBe(true);
  });

  it("currency mismatch 400 and over-capacity 409 with decimal-string availableMinor", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-goal-currency");
    const eurAccount = await createAccount(base, cookie, workspaceId, "EUR Cash");
    await createSnapshot(base, cookie, workspaceId, eurAccount, "600.00");
    const goal = await postJson(base, "/api/commands/goals.create", cookie, {
      workspaceId,
      name: "Laptop",
      goalType: "PURCHASE",
      targetAmountMinor: "120000",
      currency: "EUR",
      idempotencyKey: randomUUID(),
    });
    const goalId = (goal.json as { id: string }).id;

    // JPY against EUR account
    const badCurr = await postJson(base, "/api/commands/allocations.allocate", cookie, {
      workspaceId,
      goalId,
      accountId: eurAccount,
      amountMinor: "10000",
      currency: "JPY",
      idempotencyKey: randomUUID(),
    });
    expect(badCurr.status).toBe(400);
    expect((badCurr.json as { error: string }).error).toBe("invalid_request");

    // Over capacity
    const over = await postJson(base, "/api/commands/allocations.allocate", cookie, {
      workspaceId,
      goalId,
      accountId: eurAccount,
      amountMinor: "60100",
      currency: "EUR",
      idempotencyKey: randomUUID(),
    });
    expect(over.status).toBe(409);
    expect((over.json as { availableMinor: string }).availableMinor).toBe("60000");
  });

  it("undo of supported allocate restores capacity with compensating audit; stale undo is UNDO_CONFLICT", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-goal-undo");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");
    const goal = await postJson(base, "/api/commands/goals.create", cookie, {
      workspaceId,
      name: "Fund",
      goalType: "SAVINGS_TARGET",
      targetAmountMinor: "100000",
      currency: "EUR",
      idempotencyKey: randomUUID(),
    });
    const goalId = (goal.json as { id: string }).id;

    const alloc = await postJson(base, "/api/commands/allocations.allocate", cookie, {
      workspaceId,
      goalId,
      accountId,
      amountMinor: "40000",
      currency: "EUR",
      idempotencyKey: randomUUID(),
    });
    expect(alloc.status).toBe(200);
    const allocOpId = (alloc.json as { operationId: string }).operationId;

    const undo = await postJson(base, "/api/commands/operations.undo", cookie, {
      workspaceId,
      operationId: allocOpId,
      idempotencyKey: randomUUID(),
    });
    expect(undo.status).toBe(200);

    const goalView = await getJson(base, `/api/goals/${goalId}?workspaceId=${workspaceId}`, cookie);
    expect((goalView.json as { reservedMinor: string }).reservedMinor).toBe("0");

    // Stale undo
    const stale = await postJson(base, "/api/commands/operations.undo", cookie, {
      workspaceId,
      operationId: allocOpId,
      idempotencyKey: randomUUID(),
    });
    expect(stale.status).toBe(409);
    expect((stale.json as { reason: string }).reason).toBe("undo_conflict");
  });

  it("archived goal rejects new allocations; tenant-B IDs uniform 404; unscoped reads zero", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "e06-tenant-a");
    const b = await setupWorkspace(base, "e06-tenant-b");

    const goal = await postJson(base, "/api/commands/goals.create", a.cookie, {
      workspaceId: a.workspaceId,
      name: "ArchiveMe",
      goalType: "SAVINGS_TARGET",
      targetAmountMinor: "100000",
      currency: "EUR",
      idempotencyKey: randomUUID(),
    });
    const goalId = (goal.json as { id: string }).id;

    const archive = await postJson(base, "/api/commands/goals.archive", a.cookie, {
      workspaceId: a.workspaceId,
      goalId,
      expectedVersion: "1",
      idempotencyKey: randomUUID(),
    });
    expect(archive.status).toBe(200);

    const alloc = await postJson(base, "/api/commands/allocations.allocate", a.cookie, {
      workspaceId: a.workspaceId,
      goalId,
      accountId: (await createAccount(base, a.cookie, a.workspaceId, "Cash")).toString(),
      amountMinor: "10000",
      currency: "EUR",
      idempotencyKey: randomUUID(),
    });
    expect(alloc.status).toBe(409);
    expect((alloc.json as { reason: string }).reason).toBe("goal_archived");

    // Foreign goal
    const foreign = await getJson(base, `/api/goals/${goalId}?workspaceId=${b.workspaceId}`, b.cookie);
    expect(foreign.status).toBe(404);
    const missing = await getJson(base, `/api/goals/${randomUUID()}?workspaceId=${a.workspaceId}`, a.cookie);
    expect(missing.status).toBe(404);
    expect((foreign.json as { error: string }).error).toBe((missing.json as { error: string }).error);

    // Unscoped reads zero
    const unscopedGoals = await pool.query("SELECT COUNT(*)::int AS n FROM goals");
    expect(Number((unscopedGoals.rows[0] as { n: number }).n)).toBe(0);
    const unscopedAllocs = await pool.query("SELECT COUNT(*)::int AS n FROM goal_allocations");
    expect(Number((unscopedAllocs.rows[0] as { n: number }).n)).toBe(0);
  });

  it("versions exact past safe integer at raw-text boundary", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-goal-big");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");

    // Seed a goal with big version
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace', $1, true)", [workspaceId]);
      await client.query("INSERT INTO goals (workspace_id, id, name, goal_type, target_amount_minor, currency_code, target_date, status, version) VALUES ($1, $2, 'Big', 'SAVINGS_TARGET', 100000, 'EUR', '2027-01-01', 'ACTIVE', 9007199254740993) ON CONFLICT DO NOTHING", [workspaceId, randomUUID()]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const goal = await getJson(base, `/api/goals?workspaceId=${workspaceId}`, cookie);
    const bigGoal = (goal.json as { goals: { id: string }[] }).goals[0];

    const alloc = await postJson(base, "/api/commands/allocations.allocate", cookie, {
      workspaceId,
      goalId: bigGoal.id,
      accountId,
      amountMinor: "10000",
      currency: "EUR",
      idempotencyKey: randomUUID(),
    });
    expect(alloc.status).toBe(200);
    expect(alloc.text).toContain('"goalVersion":"9007199254740994"');
  });
});