// E06-S01 projection inputs: schedule expansion, exact remainder, weekly
// baseline honesty. Pure-function goldens are independently hand-computed;
// DB legs use real PostgreSQL (`moneo_e06_inputs`, fails closed without PG)
// with synthetic workspaces only.

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
import { distributeDaily, expandLeapDay, expandMonthly } from "../apps/web/src/projections/schedule.ts";
import { buildWeeklyBaseline } from "../apps/web/src/projections/baseline.ts";

describe("e06-s01 monthly schedule expansion", () => {
  it("clamps day-31 across month ends including leap February", () => {
    expect(expandMonthly(31, "2024-01-31", "2024-04-30")).toEqual([
      "2024-01-31",
      "2024-02-29",
      "2024-03-31",
      "2024-04-30",
    ]);
  });

  it("maps leap-day yearly recurrence to Feb 28 in non-leap years", () => {
    expect(expandLeapDay("2024-02-29", 2024, 2025)).toEqual(["2024-02-29", "2025-02-28"]);
  });
});

describe("e06-s01 exact daily remainder distribution", () => {
  it("splits 100 minor units over 7 days with remainder on earliest days", () => {
    const parts = distributeDaily(100n, 7);
    expect(parts).toEqual([15n, 15n, 14n, 14n, 14n, 14n, 14n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(100n);
  });

  it("mirrors negative totals without losing the remainder", () => {
    const parts = distributeDaily(-100n, 7);
    expect(parts).toEqual([-15n, -15n, -14n, -14n, -14n, -14n, -14n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(-100n);
  });
});

describe("e06-s01 weekly baseline median honesty", () => {
  it("takes the exact mean of two middles for even complete weeks", () => {
    const weeks = [10000n, 12000n, 11000n, 9000n, 13000n, 10500n, 11500n, 9500n].map((spendMinor, i) => ({
      start: `2026-0${1 + Math.floor(i / 4)}-01`,
      complete: true,
      spendMinor,
    }));
    const result = buildWeeklyBaseline(weeks, 8);
    expect(result).toEqual({ status: "ok", have: 8, need: 8, medianMinor: 10750n });
  });

  it("reports insufficient instead of a silent zero with 7 of 8 weeks", () => {
    const weeks = [10000n, 12000n, 11000n, 9000n, 13000n, 10500n, 11500n].map((spendMinor, i) => ({
      start: `2026-01-0${i + 1}`,
      complete: true,
      spendMinor,
    }));
    expect(buildWeeklyBaseline(weeks, 8)).toEqual({ status: "insufficient", have: 7, need: 8, medianMinor: null });
  });

  it("ignores incomplete weeks even when they would change the median", () => {
    const weeks = [
      { start: "2026-01-01", complete: true, spendMinor: 100n },
      { start: "2026-01-08", complete: true, spendMinor: 200n },
      { start: "2026-01-15", complete: true, spendMinor: 300n },
      { start: "2026-01-22", complete: true, spendMinor: 400n },
      { start: "2026-01-29", complete: true, spendMinor: 500n },
      { start: "2026-02-05", complete: false, spendMinor: 999999n },
    ];
    expect(buildWeeklyBaseline(weeks, 5)).toEqual({ status: "ok", have: 5, need: 5, medianMinor: 300n });
  });
});

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

beforeAll(async () => {
  pool = await ensureTestPool("E06-S01", "moneo_e06_inputs", [
    "financial_assumptions",
    "projection_settings",
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

describe("e06-s01 projection settings commands", () => {
  it("reads defaults, updates with CAS, replays idempotently and races safely", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-settings-a");

    const initial = await getJson(base, `/api/projection/settings?workspaceId=${workspaceId}`, cookie);
    expect(initial.status).toBe(200);
    expect(initial.json).toMatchObject({ horizonDays: 30, baselineWeeks: 8, safetyFloorMinor: "0", savingsIncluded: false, version: "0" });

    const key = randomUUID();
    const first = await postJson(base, "/api/commands/projection.settings.update", cookie, {
      workspaceId,
      expectedVersion: "0",
      horizonDays: 60,
      safetyFloorMinor: "50000",
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ horizonDays: 60, safetyFloorMinor: "50000", version: "1", replayed: false });

    const replay = await postJson(base, "/api/commands/projection.settings.update", cookie, {
      workspaceId,
      expectedVersion: "0",
      horizonDays: 60,
      safetyFloorMinor: "50000",
      idempotencyKey: key,
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ version: "1", replayed: true });

    const raced = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        postJson(base, "/api/commands/projection.settings.update", cookie, {
          workspaceId,
          expectedVersion: "1",
          baselineWeeks: 10,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    const wins = raced.filter((r) => r.status === 200);
    const conflicts = raced.filter((r) => r.status === 409);
    const serverErrors = raced.filter((r) => r.status >= 500);
    expect(wins).toHaveLength(1);
    expect(conflicts).toHaveLength(4);
    expect(serverErrors).toHaveLength(0);
    expect((conflicts[0]!.json as { reason: string }).reason).toBe("version_mismatch");
    expect((conflicts[0]!.json as { currentVersion: string }).currentVersion).toBe("2");

    const bad = await postJson(base, "/api/commands/projection.settings.update", cookie, {
      workspaceId,
      expectedVersion: "2",
      horizonDays: 731,
      idempotencyKey: randomUUID(),
    });
    expect(bad.status).toBe(400);
  });

  it("keeps versions exact past JS safe integer at the raw-text boundary", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-settings-big");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace', $1, true)", [workspaceId]);
      await client.query("INSERT INTO projection_settings (workspace_id, horizon_days, baseline_weeks, safety_floor_minor, savings_included, version) VALUES ($1, 30, 8, 0, false, 9007199254740993) ON CONFLICT (workspace_id) DO UPDATE SET version = 9007199254740993", [workspaceId]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const read = await getJson(base, `/api/projection/settings?workspaceId=${workspaceId}`, cookie);
    expect(read.status).toBe(200);
    expect(read.text).toContain('"version":"9007199254740993"');
    const bumped = await postJson(base, "/api/commands/projection.settings.update", cookie, {
      workspaceId,
      expectedVersion: "9007199254740993",
      horizonDays: 31,
      idempotencyKey: randomUUID(),
    });
    expect(bumped.status).toBe(200);
    expect(bumped.text).toContain('"version":"9007199254740994"');
  });
});

describe("e06-s01 financial assumption lifecycle", () => {
  it("supersedes same-scope rows, replays keys, archives with versions and rejects bad input", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-assume-a");

    const income = {
      workspaceId,
      assumptionType: "EXPECTED_INCOME",
      validFrom: "2026-01-01",
      value: { amountMinor: "112000", currency: "EUR", cadence: "MONTHLY", dayOfMonth: 1 },
      idempotencyKey: randomUUID(),
    };
    const first = await postJson(base, "/api/commands/assumptions.set", cookie, income);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ assumptionType: "EXPECTED_INCOME", status: "ACTIVE", version: "1" });
    const firstId = (first.json as { id: string }).id;

    const replay = await postJson(base, "/api/commands/assumptions.set", cookie, income);
    expect(replay.status).toBe(200);
    expect((replay.json as { id: string }).id).toBe(firstId);
    expect(replay.json).toMatchObject({ replayed: true });

    const second = await postJson(base, "/api/commands/assumptions.set", cookie, {
      ...income,
      value: { amountMinor: "120000", currency: "EUR", cadence: "MONTHLY", dayOfMonth: 1 },
      idempotencyKey: randomUUID(),
    });
    expect(second.status).toBe(200);
    const secondView = second.json as { id: string; supersedesId: string; version: string };
    expect(secondView.supersedesId).toBe(firstId);

    const active = (await getJson(base, `/api/projection/assumptions?workspaceId=${workspaceId}`, cookie)).json as { assumptions: { id: string }[] };
    expect(active.assumptions.map((a) => a.id)).toEqual([secondView.id]);
    const all = (await getJson(base, `/api/projection/assumptions?workspaceId=${workspaceId}&status=ALL`, cookie)).json as { assumptions: { id: string; status: string }[] };
    expect(all.assumptions).toHaveLength(2);
    expect(all.assumptions.find((a) => a.id === firstId)?.status).toBe("SUPERSEDED");

    const archived = await postJson(base, "/api/commands/assumptions.archive", cookie, {
      workspaceId,
      assumptionId: secondView.id,
      expectedVersion: "1",
      idempotencyKey: randomUUID(),
    });
    expect(archived.status).toBe(200);
    expect(archived.json).toMatchObject({ status: "ARCHIVED", version: "2" });

    const stale = await postJson(base, "/api/commands/assumptions.archive", cookie, {
      workspaceId,
      assumptionId: secondView.id,
      expectedVersion: "1",
      idempotencyKey: randomUUID(),
    });
    expect(stale.status).toBe(409);

    for (const bad of [
      { ...income, assumptionType: "NOPE", idempotencyKey: randomUUID() },
      { ...income, value: { amountMinor: "112000", currency: "EURO", cadence: "MONTHLY", dayOfMonth: 1 }, idempotencyKey: randomUUID() },
      { ...income, validFrom: "2026-02-01", validTo: "2026-01-01", idempotencyKey: randomUUID() },
      { ...income, value: { amountMinor: "11.5", currency: "EUR", cadence: "MONTHLY", dayOfMonth: 1 }, idempotencyKey: randomUUID() },
    ]) {
      const res = await postJson(base, "/api/commands/assumptions.set", cookie, bad);
      expect(res.status).toBe(400);
    }
  });
});

describe("e06-s01 baseline preview honesty", () => {
  it("reports ok with an exact median over 8+ complete weeks", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-baseline-ok");
    const accountId = await createAccount(base, cookie, workspaceId, "Cash");
    const today = "2026-04-01";
    const preview0 = (await getJson(base, `/api/projection/baseline?workspaceId=${workspaceId}&today=${today}`, cookie)).json as {
      weeks: { start: string; end: string; complete: boolean }[];
    };
    const pastWeeks = preview0.weeks.filter((w) => w.end < today);
    expect(pastWeeks.length).toBeGreaterThanOrEqual(8);
    const seeded: bigint[] = [];
    let i = 0;
    for (const week of pastWeeks.slice(0, 9)) {
      const minor = 10000n + BigInt(i) * 500n;
      const major = `${(minor / 100n).toString()}.${(minor % 100n).toString().padStart(2, "0")}`;
      const res = await postJson(base, "/api/commands/accounts.manual_transaction", cookie, {
        workspaceId,
        accountId,
        amount: major,
        currency: "EUR",
        direction: "OUTFLOW",
        effectiveDate: week.start,
        description: `Baseline spend ${i}`,
        idempotencyKey: randomUUID(),
      });
      expect(res.status).toBe(200);
      seeded.push(minor);
      i++;
    }
    const preview = (await getJson(base, `/api/projection/baseline?workspaceId=${workspaceId}&today=${today}`, cookie)).json as {
      status: string;
      have: number;
      need: number;
      medianMinor: string;
      openImportCount: number;
      pendingReviewCount: number;
    };
    const sorted = [...seeded].sort((a, b) => (a < b ? -1 : 1));
    const expectedMedian = sorted[Math.floor(sorted.length / 2)]!.toString();
    expect(preview.status).toBe("ok");
    expect(preview.have).toBeGreaterThanOrEqual(8);
    expect(preview.need).toBe(8);
    expect(preview.medianMinor).toBe(expectedMedian);
    expect(preview.openImportCount).toBe(0);
    expect(preview.pendingReviewCount).toBe(0);
  });

  it("reports insufficient with no booked history instead of zero", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e06-baseline-empty");
    const preview = (await getJson(base, `/api/projection/baseline?workspaceId=${workspaceId}&today=2026-04-01`, cookie)).json as {
      status: string;
      have: number;
      medianMinor: string | null;
    };
    expect(preview.status).toBe("insufficient");
    expect(preview.have).toBe(0);
    expect(preview.medianMinor).toBeNull();
  });
});

describe("e06-s01 tenant isolation", () => {
  it("hides foreign settings and returns zero unscoped rows", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "e06-tenant-a");
    const b = await setupWorkspace(base, "e06-tenant-b");
    const foreign = await getJson(base, `/api/projection/settings?workspaceId=${a.workspaceId}`, b.cookie);
    expect(foreign.status).toBe(404);
    const foreignPost = await postJson(base, "/api/commands/projection.settings.update", b.cookie, {
      workspaceId: a.workspaceId,
      expectedVersion: "0",
      horizonDays: 90,
      idempotencyKey: randomUUID(),
    });
    expect(foreignPost.status).toBe(404);
    const missing = await getJson(base, `/api/projection/settings?workspaceId=${randomUUID()}`, b.cookie);
    expect(missing.status).toBe(404);
    expect((foreign.json as { error: string }).error).toBe((missing.json as { error: string }).error);
    const unscoped = await pool.query("SELECT COUNT(*)::int AS n FROM projection_settings");
    expect(Number((unscoped.rows[0] as { n: number }).n)).toBe(0);
    const unscopedAssumptions = await pool.query("SELECT COUNT(*)::int AS n FROM financial_assumptions");
    expect(Number((unscopedAssumptions.rows[0] as { n: number }).n)).toBe(0);
  });
});
