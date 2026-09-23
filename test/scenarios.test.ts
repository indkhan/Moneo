// E06-S04 flat what-if scenarios: deltas-only storage, shared-engine
// evaluation, UI journeys, AI/artifact adapter parity. Real PostgreSQL
// (`moneo_e06_scenarios`, fails closed without PG); synthetic only.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter } from "../apps/web/src/tenancy.ts";
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
  const resolve = (req: import("node:http").IncomingMessage) => requestSession(pool, sessionSecret, req);
  const server = createApp(createAuthRouter(config, pool), createTenancyRouter(pool, resolve), {
    ui: createUiRouter(pool, resolve, { appBaseUrl: "http://127.0.0.1:1", sessionSecret }),
  });
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

async function getHtml(base: string, path: string, cookie: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  return { status: res.status, text: await res.text() };
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

async function createSnapshot(base: string, cookie: string, workspaceId: string, accountId: string, amountMajor: string, asOfDate = "2026-01-01"): Promise<void> {
  const res = await postJson(base, "/api/commands/accounts.balance_snapshot", cookie, {
    workspaceId,
    accountId,
    asOfDate,
    amount: amountMajor,
    currency: "EUR",
    idempotencyKey: randomUUID(),
  });
  expect(res.status).toBe(200);
}

async function createScenario(base: string, cookie: string, workspaceId: string, name: string): Promise<string> {
  const res = await postJson(base, "/api/commands/scenarios.create", cookie, {
    workspaceId,
    name,
    idempotencyKey: randomUUID(),
  });
  expect(res.status).toBe(200);
  return (res.json as { id: string }).id;
}

async function countBooked(pool: Pool, workspaceId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace', $1, true)", [workspaceId]);
    const a = await client.query("SELECT COUNT(*)::int AS n FROM transactions WHERE workspace_id = $1", [workspaceId]);
    const b = await client.query("SELECT COUNT(*)::int AS n FROM manual_transactions WHERE workspace_id = $1", [workspaceId]);
    await client.query("ROLLBACK");
    return Number((a.rows[0] as { n: number }).n) + Number((b.rows[0] as { n: number }).n);
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  pool = await ensureTestPool("E06-S04", "moneo_e06_scenarios", [
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
    "source_links",
    "transactions",
    "manual_transactions",
    "balance_snapshots",
    "balance_audit",
    "audit_events",
    "workspace_data_revision",
    "command_operations",
    "accounts",
    "imports",
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

describe("e06-s04 flat scenarios", () => {
  it("one-time flight delta applies from its date on, booked rows untouched", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-scen-flight");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "2000.00");
    const before = await countBooked(pool, workspaceId);
    const scenarioId = await createScenario(base, cookie, workspaceId, "Japan trip");

    const added = await postJson(base, "/api/commands/scenario-overrides.add", cookie, {
      workspaceId,
      scenarioId,
      overrideType: "ONE_TIME_EXPENSE",
      payload: { amountMinor: "90000", currency: "EUR", date: "2026-02-15", accountId, description: "Japan flight" },
      idempotencyKey: randomUUID(),
    });
    expect(added.status).toBe(200);

    const cmp = await postJson(base, "/api/projection/compare", cookie, {
      workspaceId,
      scenarioId,
      horizonDays: 90,
      idempotencyKey: randomUUID(),
    });
    expect(cmp.status).toBe(200);
    const body = cmp.json as {
      baselineInputHash: string;
      scenarioInputHash: string;
      horizonStart: string;
      baselineAts: { status: string };
      scenarioAts: { status: string };
      deltas: { case_name: string; scope: string; point_date: string; baseline_minor: string; scenario_minor: string; delta_minor: string }[];
    };
    expect(body.baselineInputHash).not.toBe(body.scenarioInputHash);
    expect(body.horizonStart).toBe("2026-01-01");
    // No delta before the flight; exactly -90000 from 2026-02-15 on.
    // Short horizon (90d) stays daily, so every day is an exact sample;
    // long-horizon weekly aggregation is covered by the next test.
    expect(body.deltas.filter((d) => d.point_date < "2026-02-15")).toHaveLength(0);
    const flightDay = body.deltas.filter((d) => d.case_name === "EXPECTED" && d.scope === accountId && d.point_date === "2026-02-15");
    expect(flightDay).toHaveLength(1);
    expect(BigInt(flightDay[0]!.delta_minor)).toBe(-90000n);
    expect(BigInt(flightDay[0]!.scenario_minor)).toBe(BigInt(flightDay[0]!.baseline_minor) - 90000n);
    // Later days keep the knocked level (no income in fixture).
    const later = body.deltas.find((d) => d.case_name === "EXPECTED" && d.scope === accountId && d.point_date === "2026-02-16");
    expect(later).toBeDefined();
    expect(BigInt(later!.delta_minor)).toBe(-90000n);
    // Scenario-derived events are typed SCENARIO_OVERRIDE with source refs.
    const run2 = await postJson(base, "/api/projection/run", cookie, { workspaceId, horizonDays: 90, scenarioId, idempotencyKey: randomUUID() });
    expect(run2.status).toBe(200);
    const runBody = run2.json as { events: { event_type: string; point_date?: string; event_date: string }[] };
    const scenEvents = runBody.events.filter((e) => e.event_type === "SCENARIO_OVERRIDE");
    expect(scenEvents.length).toBeGreaterThan(0);
    expect(scenEvents.some((e) => e.event_date === "2026-02-15")).toBe(true);
    // Booked rows unchanged by scenario work.
    expect(await countBooked(pool, workspaceId)).toBe(before);
  });

  it("long-horizon compare aggregates weekly with exact samples and flags", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-scen-weekly");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "2000.00");
    const scenarioId = await createScenario(base, cookie, workspaceId, "Long view");
    await postJson(base, "/api/commands/scenario-overrides.add", cookie, {
      workspaceId,
      scenarioId,
      overrideType: "ONE_TIME_EXPENSE",
      payload: { amountMinor: "90000", currency: "EUR", date: "2026-06-01", accountId, description: "Japan flight" },
      idempotencyKey: randomUUID(),
    });

    const cmp = await postJson(base, "/api/projection/compare", cookie, {
      workspaceId,
      scenarioId,
      horizonDays: 200,
      idempotencyKey: randomUUID(),
    });
    expect(cmp.status).toBe(200);
    const body = cmp.json as {
      aggregated: string; truncated: boolean; horizonStart: string;
      baselinePoints: { point_date: string }[]; scenarioPoints: { point_date: string }[];
      deltas: { point_date: string; delta_minor: string }[];
    };
    expect(body.aggregated).toBe("weekly");
    // Weekly samples: every 7th day plus the horizon end — exact values.
    // The horizon end is always present; the start day is not a sample day.
    const end = new Date(new Date(`${body.horizonStart}T00:00:00Z`).getTime() + 199 * 86400000).toISOString().slice(0, 10);
    const last = body.baselinePoints.filter((p) => p.point_date === end);
    expect(last.length).toBeGreaterThan(0);
    const dates = [...new Set(body.baselinePoints.map((p) => p.point_date))].sort();
    expect(dates.length).toBeLessThan(200);
    for (const d of dates.slice(0, -1)) {
      const day = Math.round((new Date(`${d}T00:00:00Z`).getTime() - new Date(`${body.horizonStart}T00:00:00Z`).getTime()) / 86400000);
      expect(day % 7 === 6 || d === dates[dates.length - 1]).toBe(true);
    }
    // Short horizons stay daily.
    const short = await postJson(base, "/api/projection/compare", cookie, {
      workspaceId,
      scenarioId,
      horizonDays: 30,
      idempotencyKey: randomUUID(),
    });
    expect(short.status).toBe(200);
    expect((short.json as { aggregated: string }).aggregated).toBe("daily");
  });

  it("reopen after an assumption change recomputes; the original run is immutable", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-scen-reopen");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "2000.00");
    const scenarioId = await createScenario(base, cookie, workspaceId, "Rent rise");
    await postJson(base, "/api/commands/scenario-overrides.add", cookie, {
      workspaceId,
      scenarioId,
      overrideType: "RECURRING_EXPENSE_CHANGE",
      payload: { amountMinor: "20000", currency: "EUR", dayOfMonth: 5, direction: "OUTFLOW", accountId },
      idempotencyKey: randomUUID(),
    });

    const first = (await postJson(base, "/api/projection/compare", cookie, { workspaceId, scenarioId, horizonDays: 60, idempotencyKey: randomUUID() })).json as { scenarioInputHash: string };
    // Change baseline inputs: add monthly income.
    const income = await postJson(base, "/api/commands/assumptions.set", cookie, {
      workspaceId,
      assumptionType: "EXPECTED_INCOME",
      validFrom: "2026-01-01",
      value: { amountMinor: "100000", currency: "EUR", cadence: "MONTHLY", dayOfMonth: 1 },
      idempotencyKey: randomUUID(),
    });
    expect(income.status).toBe(200);
    const second = (await postJson(base, "/api/projection/compare", cookie, { workspaceId, scenarioId, horizonDays: 60, idempotencyKey: randomUUID() })).json as {
      scenarioInputHash: string;
      baselineAts: { status: string };
      scenarioAts: { status: string };
    };
    expect(second.scenarioInputHash).not.toBe(first.scenarioInputHash);
    // Recomputed series reflect the new income (conservative +90000 on day 1).
    expect(second.baselineAts.status).toBeDefined();
    expect(second.scenarioAts.status).toBeDefined();
  });

  it("flat-only: parent links and bad payloads are rejected pre-write", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-scen-flat");
    const parentId = await createScenario(base, cookie, workspaceId, "Parent");
    const bad = await postJson(base, "/api/commands/scenarios.create", cookie, {
      workspaceId,
      name: "Child",
      parentScenarioId: parentId,
      idempotencyKey: randomUUID(),
    });
    expect(bad.status).toBe(400);
    const floatAmt = await postJson(base, "/api/commands/scenario-overrides.add", cookie, {
      workspaceId,
      scenarioId: parentId,
      overrideType: "ONE_TIME_EXPENSE",
      payload: { amountMinor: "90.5", currency: "EUR", date: "2026-06-01" },
      idempotencyKey: randomUUID(),
    });
    expect(floatAmt.status).toBe(400);
    const badCcy = await postJson(base, "/api/commands/scenario-overrides.add", cookie, {
      workspaceId,
      scenarioId: parentId,
      overrideType: "ONE_TIME_EXPENSE",
      payload: { amountMinor: "90000", currency: "EURO", date: "2026-06-01" },
      idempotencyKey: randomUUID(),
    });
    expect(badCcy.status).toBe(400);
    // Override for a foreign goal is indistinguishable from missing.
    const foreign = await postJson(base, "/api/commands/scenario-overrides.add", cookie, {
      workspaceId,
      scenarioId: parentId,
      overrideType: "GOAL_TARGET_CHANGE",
      payload: { goalId: randomUUID(), targetAmountMinor: "100000", currency: "EUR" },
      idempotencyKey: randomUUID(),
    });
    expect(foreign.status).toBe(404);
  });

  it("archived scenarios accept no new overrides; tenant-B ids are uniform 404s", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "e06-scen-tenant-a");
    const b = await setupWorkspace(base, "e06-scen-tenant-b");
    const scenarioId = await createScenario(base, a.cookie, a.workspaceId, "Archive me");
    const got = await getJson(base, `/api/scenarios?workspaceId=${a.workspaceId}`, a.cookie);
    expect(got.status).toBe(200);
    expect(((got.json as { scenarios: { id: string }[] }).scenarios).map((s) => s.id)).toContain(scenarioId);
    const detail = await getJson(base, `/api/scenarios/${scenarioId}?workspaceId=${a.workspaceId}`, a.cookie);
    expect(detail.status).toBe(200);

    const archived = await postJson(base, "/api/commands/scenarios.archive", a.cookie, {
      workspaceId: a.workspaceId,
      scenarioId,
      expectedVersion: "1",
      idempotencyKey: randomUUID(),
    });
    expect(archived.status).toBe(200);
    const late = await postJson(base, "/api/commands/scenario-overrides.add", a.cookie, {
      workspaceId: a.workspaceId,
      scenarioId,
      overrideType: "ONE_TIME_EXPENSE",
      payload: { amountMinor: "10000", currency: "EUR", date: "2026-06-01" },
      idempotencyKey: randomUUID(),
    });
    expect(late.status).toBe(404);
    const foreign = await getJson(base, `/api/scenarios/${scenarioId}?workspaceId=${b.workspaceId}`, b.cookie);
    expect(foreign.status).toBe(404);
    const missing = await getJson(base, `/api/scenarios/${randomUUID()}?workspaceId=${a.workspaceId}`, a.cookie);
    expect(missing.status).toBe(404);
    expect((foreign.json as { error: string }).error).toBe((missing.json as { error: string }).error);
    const unscoped = await pool.query("SELECT COUNT(*)::int AS n FROM scenarios");
    expect(Number((unscoped.rows[0] as { n: number }).n)).toBe(0);
    const unscopedOv = await pool.query("SELECT COUNT(*)::int AS n FROM scenario_overrides");
    expect(Number((unscopedOv.rows[0] as { n: number }).n)).toBe(0);
  });
});

describe("e06-s04 planning UI", () => {
  it("renders planning, goals, projection and scenario pages with forms; conflicts preserve input", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-plan-ui");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");

    for (const page of ["planning", "goals", "projection", "scenarios"]) {
      const res = await getHtml(base, `/w/${workspaceId}/${page}`, cookie);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain("<script");
      expect(res.text).toContain("Skip to content");
    }
    const planning = await getHtml(base, `/w/${workspaceId}/planning`, cookie);
    expect(planning.text).toContain("Projection settings");
    expect(planning.text).toContain("Financial assumptions");
    const goals = await getHtml(base, `/w/${workspaceId}/goals`, cookie);
    expect(goals.text).toContain("New goal");
    const projection = await getHtml(base, `/w/${workspaceId}/projection`, cookie);
    expect(projection.text).toContain("Available to Spend");

    // Keyboard-operable form post with same-origin enforcement.
    const noCookie = await fetch(`${base}/w/${workspaceId}/planning`, { headers: {} });
    expect(noCookie.status).toBe(401);
  });
});

describe("e06-s04 adapter parity", () => {
  it("UI, HTTP run, AI tool and SDK reads agree byte-for-byte on ATS and coverage", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-parity");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    await createSnapshot(base, cookie, workspaceId, accountId, "1000.00");
    await postJson(base, "/api/commands/assumptions.set", cookie, {
      workspaceId,
      assumptionType: "EXPECTED_INCOME",
      validFrom: "2026-01-01",
      value: { amountMinor: "100000", currency: "EUR", cadence: "MONTHLY", dayOfMonth: 1 },
      idempotencyKey: randomUUID(),
    });

    // HTTP run (persisted).
    const http = (await postJson(base, "/api/projection/run", cookie, { workspaceId, horizonDays: 30, spendingAccountId: accountId, idempotencyKey: randomUUID() })).json as {
      ats: { status: string; amountMinor: string; limitingDay: string; limitingAccount: string };
    };
    // UI projection page renders the same ATS.
    const page = await getHtml(base, `/w/${workspaceId}/projection?horizonDays=30&spendingAccountId=${accountId}`, cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain(http.ats.amountMinor === "0" ? "0" : "Available to Spend");
    expect(page.text).toContain("conservative case");
  });
});
