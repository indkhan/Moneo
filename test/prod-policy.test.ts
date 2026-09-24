// E08-S03-L production-route policy: pinned no-training/ZDR capability at
// reserve, rechecked at execute/fallback, free-model refusal, honest
// disclosure and frozen-rubric pinning. Real disposable PostgreSQL
// (`moneo_e08_prodpolicy`, fails closed); scripted transports only — no live
// provider, no customer data. Recording transports prove zero requests leave
// the process on every deny path.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { issuePermit } from "../apps/web/src/ai-policy.ts";
import {
  DispatchError,
  executeReserved,
  isFreeModel,
  liveChatTransport,
  loadProductionRouteConfig,
  reserveDispatch,
  type DispatchAttempt,
  type DispatchTransport,
} from "../apps/web/src/ai-dispatch.ts";
import { EVAL_DATASET_VERSION, EVAL_RUBRIC_VERSION } from "../apps/web/src/ai-eval.ts";
import { PROCESSOR_INVENTORY, productionDisclosureReady, renderProcessorDisclosureHtml } from "../apps/web/src/ai-processors.ts";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

const PROD_VARS = ["AI_PRODUCTION_QUALIFIED", "AI_PROD_DATA_COLLECTION", "AI_PROD_ZDR", "DISPATCH_PROD_MODEL", "AI_PROD_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");

function setProdEnv(partial: Record<string, string>): void {
  for (const name of PROD_VARS) delete process.env[name];
  for (const [name, value] of Object.entries(partial)) process.env[name] = value;
}

const QUALIFIED = {
  AI_PRODUCTION_QUALIFIED: "1",
  AI_PROD_DATA_COLLECTION: "deny",
  AI_PROD_ZDR: "true",
  DISPATCH_PROD_MODEL: "muse-spark-1.3",
  AI_PROD_API_KEY: "synthetic-test-key",
};

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

async function setupWorkspace(base: string, sub: string): Promise<{ cookie: string; userId: string; workspaceId: string; acctA: string }> {
  const cookie = await login(base, sub);
  const headers = { cookie, "Content-Type": "application/json" };
  const ws = (await (await fetch(`${base}/api/workspaces`, { method: "POST", headers, body: JSON.stringify({ name: "ProdW", baseCurrency: "EUR" }) })).json()) as { id: string };
  const acctA = ((await (await fetch(`${base}/api/accounts`, { method: "POST", headers, body: JSON.stringify({ workspaceId: ws.id, name: "Cash" }) })).json()) as { id: string }).id;
  const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub])).rows[0] as { id: string }).id;
  return { cookie, userId, workspaceId: ws.id, acctA };
}

function recordingTransport(calls: { count: number }, attempt: DispatchAttempt): DispatchTransport {
  return async () => {
    calls.count += 1;
    return attempt;
  };
}

const okAttempt: DispatchAttempt = { httpStatus: 200, bodyText: '{"answer":"synthetic"}', inputTokens: 100, outputTokens: 50, model: "double-1" };

async function freshPermit(userId: string, workspaceId: string, acctA: string): Promise<string> {
  const permit = await issuePermit(pool, { userId, workspaceId }, "prod-policy-probe", [acctA]);
  return permit.id;
}

beforeAll(async () => {
  process.env["APP_ENV"] = "test";
  for (const name of [...PROD_VARS, "APP_ENV"]) savedEnv[name] = process.env[name];
  pool = await ensureTestPool("E08-S03-L", "moneo_e08_prodpolicy", [
    "ai_dispatch_usage", "ai_dispatch_reservations", "ai_dispatch_budgets",
    "ai_dispatch_permits", "ai_exclusions", "ai_policies", "command_operations",
    "accounts", "workspace_members", "workspaces", "users", "app_sessions",
  ]);
  stub = await startStubIssuer();
}, 60_000);

afterEach(() => {
  setProdEnv(QUALIFIED);
});

afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e08-s03-L production-route policy", () => {
  it("isFreeModel spots free variants without blocking pinned models", () => {
    expect(isFreeModel("x:free")).toBe(true);
    expect(isFreeModel("X:FREE")).toBe(true);
    expect(isFreeModel("muse-spark-1.3")).toBe(false);
    expect(isFreeModel("dispatch-double")).toBe(false);
  });

  it("every capability gap fails closed at reserve with no transport", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-prod-matrix-a");
    const cases: Array<{ name: string; env: Record<string, string> }> = [
      { name: "unqualified", env: {} },
      { name: "flag-only", env: { AI_PRODUCTION_QUALIFIED: "1" } },
      { name: "collection-not-deny", env: { ...QUALIFIED, AI_PROD_DATA_COLLECTION: "allow" } },
      { name: "zdr-off", env: { ...QUALIFIED, AI_PROD_ZDR: "false" } },
      { name: "model-missing", env: { ...QUALIFIED, DISPATCH_PROD_MODEL: "" } },
      { name: "model-free", env: { ...QUALIFIED, DISPATCH_PROD_MODEL: "some-model:free" } },
      { name: "key-missing", env: { ...QUALIFIED, AI_PROD_API_KEY: "" } },
    ];
    for (const [i, c] of cases.entries()) {
      setProdEnv(c.env);
      const permitId = await freshPermit(me.userId, me.workspaceId, me.acctA);
      try {
        await reserveDispatch(pool, { userId: me.userId, workspaceId: me.workspaceId }, {
          idempotencyKey: randomUUID(), permitId, route: "production", purpose: `matrix-${i}`, requestText: "synthetic", inputEstimate: 100, outputCeiling: 100,
        });
        expect.unreachable(`matrix case ${c.name} admitted a production dispatch`);
      } catch (err) {
        expect(err).toBeInstanceOf(DispatchError);
        expect((err as DispatchError).code).toBe("route_forbidden");
      }
    }
    // No production reservation exists after the matrix: zero leakage surface.
    const pending = await pool.query("SELECT count(*)::int AS n FROM ai_dispatch_reservations WHERE workspace_id = $1 AND route = 'production'", [me.workspaceId]);
    expect((pending.rows[0] as { n: number }).n).toBe(0);
    setProdEnv(QUALIFIED);
  });

  it("qualified production reserves and reconciles without fallback", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-prod-happy-a");
    setProdEnv(QUALIFIED);
    const calls = { count: 0 };
    const permitId = await freshPermit(me.userId, me.workspaceId, me.acctA);
    const reservation = await reserveDispatch(pool, { userId: me.userId, workspaceId: me.workspaceId }, {
      idempotencyKey: randomUUID(), permitId, route: "production", purpose: "happy", requestText: "synthetic", inputEstimate: 100, outputCeiling: 100,
    });
    expect(reservation.route).toBe("production");
    const done = await executeReserved(pool, { userId: me.userId, workspaceId: me.workspaceId }, reservation.id, recordingTransport(calls, okAttempt), "synthetic");
    expect(done.reservation.status).toBe("RECONCILED");
    expect(done.usage?.status).toBe("RECONCILED");
    expect(calls.count).toBe(1);
    expect(loadProductionRouteConfig()).toMatchObject({ dataCollection: "deny", zdr: true });
  });

  it("dequalification between reserve and execute releases with zero provider I/O", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, "synthetic-prod-revoke-a");
    setProdEnv(QUALIFIED);
    const calls = { count: 0 };
    const permitId = await freshPermit(me.userId, me.workspaceId, me.acctA);
    const reservation = await reserveDispatch(pool, { userId: me.userId, workspaceId: me.workspaceId }, {
      idempotencyKey: randomUUID(), permitId, route: "production", purpose: "revoke", requestText: "synthetic", inputEstimate: 100, outputCeiling: 100,
    });
    setProdEnv({});
    const done = await executeReserved(pool, { userId: me.userId, workspaceId: me.workspaceId }, reservation.id, recordingTransport(calls, okAttempt), "synthetic");
    expect(done.reservation.status).toBe("RELEASED");
    expect(done.usage?.errorClass).toBe("route_forbidden");
    expect(calls.count).toBe(0);
    // The released hold frees budget: a development call still fits.
    setProdEnv(QUALIFIED);
    const devPermit = await freshPermit(me.userId, me.workspaceId, me.acctA);
    const dev = await reserveDispatch(pool, { userId: me.userId, workspaceId: me.workspaceId }, {
      idempotencyKey: randomUUID(), permitId: devPermit, route: "development", purpose: "after-release", requestText: "synthetic", inputEstimate: 100, outputCeiling: 100,
    });
    expect(dev.status).toBe("RESERVED");
  });

  it("free-model production attempts fail at the transport without sending", async () => {
    let hits = 0;
    let lastAuth: string | null = null;
    let lastModel: string | null = null;
    const hitServer: Server = (await import("node:http")).createServer((req, res) => {
      hits += 1;
      lastAuth = (req.headers.authorization as string | undefined) ?? null;
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          lastModel = (JSON.parse(body) as { model?: unknown }).model as string ?? null;
        } catch {
          lastModel = null;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
    });
    await new Promise<void>((resolve) => hitServer.listen(0, "127.0.0.1", resolve));
    appServers.push(hitServer);
    const hitBase = `http://127.0.0.1:${(hitServer.address() as AddressInfo).port}`;
    try {
      const freeTransport = liveChatTransport({ apiKey: "synthetic", baseUrl: hitBase, model: "some-model:free" });
      const blocked = await freeTransport({ route: "production", model: "some-model:free", requestText: "synthetic", maxOutputTokens: 10 }, AbortSignal.timeout(5000));
      expect(blocked.bodyText).toBeNull();
      expect(hits).toBe(0);
      const devTransport = liveChatTransport({ apiKey: "synthetic", baseUrl: hitBase, model: "some-model:free" });
      const devRes = await devTransport({ route: "development", model: "some-model:free", requestText: "synthetic", maxOutputTokens: 10 }, AbortSignal.timeout(5000));
      expect(devRes.bodyText).toBe("hi");
      expect(hits).toBe(1);
      // With a complete production config, production requests send over
      // production credentials only (never the dev key/route).
      const bothTransport = liveChatTransport(
        { apiKey: "synthetic-dev", baseUrl: hitBase, model: "dev-model" },
        { apiKey: "synthetic-prod", baseUrl: hitBase, model: "muse-spark-1.3" },
      );
      const prodRes = await bothTransport({ route: "production", model: "muse-spark-1.3", requestText: "synthetic", maxOutputTokens: 10 }, AbortSignal.timeout(5000));
      expect(prodRes.bodyText).toBe("hi");
      expect(hits).toBe(2);
      // Production credentials and the pinned model — never the dev ones.
      expect(lastAuth).toBe("Bearer synthetic-prod");
      expect(lastModel).toBe("muse-spark-1.3");
    } finally {
      await new Promise<void>((resolve) => hitServer.close(() => resolve()));
    }
  });

  it("disclosure names development reality and pending production terms", () => {
    const byName = Object.fromEntries(PROCESSOR_INVENTORY.map((p) => [p.name, p]));
    expect(byName["OpenRouter (development route)"].training).toMatch(/Training-permitted/);
    expect(byName["OpenRouter (development route)"].status).toBe("development-only");
    expect(byName["Production inference route"].status).toBe("pending-qualification");
    expect(byName["Production inference route"].dpa).toMatch(/Not signed/);
    expect(productionDisclosureReady()).toBe(false);
    const html = renderProcessorDisclosureHtml();
    expect(html).toContain("pending-qualification");
    expect(html).toContain("stays disabled until S03-D");
    expect(html).not.toContain("<script");
  });

  it("pins the frozen evaluation rubric versions", () => {
    expect(EVAL_RUBRIC_VERSION).toBe("e04-s07-rubric-1");
    expect(EVAL_DATASET_VERSION).toBe("e04-s07-dataset-1");
  });
});
