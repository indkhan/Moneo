// E01-S06 shell + controls: server-rendered HTML (zero client JS, strict
// escaping), redacted correlated logs, rate/in-flight caps, DB-aware
// readiness, visible denial/recovery. Real PG (own `moneo_e01_ui` DB) for
// shell flows; service-free unit tests for the controls.

import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import type { Session } from "../apps/web/src/session-store.ts";
import { createControls, type LogLine } from "../apps/web/src/http-controls.ts";
import { createTenancyRouter } from "../apps/web/src/tenancy.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");

type TestApp = { base: string; logs: LogLine[] };

async function startApp(opts: { limits?: { authMax?: number; mutatingMax?: number; maxInflight?: number }; dbPing?: () => Promise<boolean> } = {}): Promise<TestApp> {
  const logs: LogLine[] = [];
  const config: AuthConfig = {
    issuer: stub.base,
    clientId: STUB_CLIENT_ID,
    clientSecret: STUB_CLIENT_SECRET,
    appBaseUrl: "http://127.0.0.1:1",
    sessionSecret,
    sessionTtlSec: 43200,
  };
  const uiConfig = { appBaseUrl: "http://127.0.0.1:1" };
  const resolve = (req: IncomingMessage): Promise<Session | null> => requestSession(pool, sessionSecret, req);
  const server = createApp(createAuthRouter(config, pool), createTenancyRouter(pool, resolve), {
    ui: createUiRouter(pool, resolve, uiConfig),
    controls: createControls({ logger: (line) => logs.push(line), authMax: opts.limits?.authMax, mutatingMax: opts.limits?.mutatingMax, maxInflight: opts.limits?.maxInflight }),
    dbPing: opts.dbPing,
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  appServers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Routers read base URLs lazily per request (origin allowlist + redirects).
  config.appBaseUrl = base;
  uiConfig.appBaseUrl = base;
  return { base, logs };
}

async function login(base: string, loginAs: string): Promise<{ cookie: string; code: string }> {
  const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const authorizeUrl = `${start.headers.get("location")!}&login_as=${loginAs}`;
  const callbackUrl = (await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!;
  const code = new URL(callbackUrl).searchParams.get("code")!;
  const done = await fetch(callbackUrl, { redirect: "manual" });
  return { cookie: done.headers.get("set-cookie")!.split(";")[0], code };
}

async function setupWorkspace(base: string, cookie: string, name: string): Promise<string> {
  const ws = (await (await fetch(`${base}/api/workspaces`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name, baseCurrency: "EUR" }),
  })).json()) as { id: string };
  return ws.id;
}

async function setupAccount(base: string, cookie: string, workspaceId: string, name: string): Promise<string> {
  const acct = (await (await fetch(`${base}/api/accounts`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, name }),
  })).json()) as { id: string };
  return acct.id;
}

function form(body: Record<string, string>): { payload: string; headers: Record<string, string> } {
  return { payload: new URLSearchParams(body).toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" } };
}

beforeAll(async () => {
  // Own database: parallel vitest workers must not share suite state.
  pool = await ensureTestPool("E01-S06", "moneo_e01_ui", ["ai_dispatch_permits", "ai_exclusions", "ai_policies", "command_operations", "accounts", "workspace_members", "workspaces", "users", "app_sessions"]);
  stub = await startStubIssuer();
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e01-s06 shell and controls", () => {
  it("landing and workspace pages are structured, labelled, script-free HTML", async () => {
    const { base } = await startApp();
    const landing = await fetch(`${base}/`, { headers: { Accept: "text/html" } });
    expect(landing.status).toBe(200);
    expect(landing.headers.get("content-type")).toContain("text/html");
    const landingHtml = await landing.text();
    expect(landingHtml).toContain('href="#main"');
    expect(landingHtml).toContain("<main");
    expect(landingHtml).toContain('aria-label="Primary"');
    expect(landingHtml).toContain("/auth/login");
    expect(landingHtml).not.toContain("<script");
    expect(landing.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

    const { cookie } = await login(base, "synthetic-ui-a");
    const ws = await setupWorkspace(base, cookie, "Home");
    const page = await fetch(`${base}/w/${ws}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("No accounts yet.");
    expect(html).toContain("AI coverage: full");
    expect(html).not.toContain("<script");
  });

  it("account names render escaped in HTML while JSON stays exact", async () => {
    const { base } = await startApp();
    const { cookie } = await login(base, "synthetic-ui-b");
    const ws = await setupWorkspace(base, cookie, "W");
    const evil = `<script>alert(1)</script>`;
    const id = await setupAccount(base, cookie, ws, evil);
    const html = await (await fetch(`${base}/w/${ws}`, { headers: { cookie } })).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const raw = await (await fetch(`${base}/api/accounts/${id}?workspaceId=${ws}`, { headers: { cookie } })).text();
    expect(raw).toContain(evil); // JSON is exact; escaping is an HTML-layer duty
  });

  it("form rename replays safely and conflicts recover with the current version", async () => {
    const { base } = await startApp();
    const { cookie } = await login(base, "synthetic-ui-c");
    const ws = await setupWorkspace(base, cookie, "W");
    const id = await setupAccount(base, cookie, ws, "Old");
    const key = randomUUID();
    const post = (body: Record<string, string>) => {
      const f = form(body);
      return fetch(`${base}/w/${ws}/rename`, { method: "POST", headers: { cookie, origin: base, ...f.headers }, body: f.payload, redirect: "manual" });
    };
    const first = await post({ accountId: id, name: "New", expectedVersion: "1", idempotencyKey: key });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toContain("notice=renamed");
    const replay = await post({ accountId: id, name: "New", expectedVersion: "1", idempotencyKey: key });
    expect(replay.status).toBe(303); // same form resubmitted: safe replay
    const stale = await post({ accountId: id, name: "Other", expectedVersion: "1", idempotencyKey: randomUUID() });
    expect(stale.status).toBe(409);
    const conflictHtml = await stale.text();
    expect(conflictHtml).toContain('role="alert"');
    expect(conflictHtml).toContain("Current version is 2");
    expect(conflictHtml).toContain('name="expectedVersion" value="2"'); // prefilled retry
    expect(conflictHtml).not.toContain("<script");
    // Cross-origin form posts are rejected.
    const cross = await fetch(`${base}/w/${ws}/rename`, { method: "POST", headers: { cookie, origin: "https://evil.invalid", ...form({ accountId: id, name: "X", expectedVersion: "2", idempotencyKey: randomUUID() }).headers }, body: form({ accountId: id, name: "X", expectedVersion: "2", idempotencyKey: randomUUID() }).payload, redirect: "manual" });
    expect(cross.status).toBe(403);
  });

  it("cross-tenant workspace ids render the error shell, never data", async () => {
    const { base } = await startApp();
    const a = await login(base, "synthetic-ui-d");
    const b = await login(base, "synthetic-ui-e");
    const wsB = await setupWorkspace(base, b.cookie, "B's own");
    const page = await fetch(`${base}/w/${wsB}`, { headers: { cookie: a.cookie } });
    expect(page.status).toBe(404);
    const html = await page.text();
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("B&#39;s own");
    expect(html).not.toContain("B's own");
    const anon = await fetch(`${base}/w/${wsB}`);
    expect(anon.status).toBe(401);
  });

  it("exclusion toggles post back with the new policy version", async () => {
    const { base } = await startApp();
    const { cookie } = await login(base, "synthetic-ui-f");
    const ws = await setupWorkspace(base, cookie, "W");
    const id = await setupAccount(base, cookie, ws, "Savings");
    const f = form({ accountId: id, excluded: "true" });
    const toggled = await fetch(`${base}/w/${ws}/exclusions`, { method: "POST", headers: { cookie, origin: base, ...f.headers }, body: f.payload, redirect: "manual" });
    expect(toggled.status).toBe(303);
    expect(toggled.headers.get("location")).toContain("policyVersion=2");
    const html = await (await fetch(`${base}/w/${ws}`, { headers: { cookie } })).text();
    expect(html).toContain("excluded");
    expect(html).toContain("AI coverage: partial");
  });

  it("logs are redacted and correlated; request ids are unique", async () => {
    const { base, logs } = await startApp();
    const seen = await login(base, "synthetic-ui-g");
    await fetch(`${base}/api/me`, { headers: { cookie: seen.cookie } });
    await fetch(`${base}/nope`);
    const ids = new Set<string>();
    for (const line of logs) {
      expect(Object.keys(line).sort()).toEqual(["id", "method", "ms", "path", "status"]);
      expect(line.id).toMatch(/^[0-9a-f-]{36}$/);
      ids.add(line.id);
      expect(line.path).not.toContain("?");
    }
    expect(ids.size).toBe(logs.length); // unique per request
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(seen.code); // auth code never logged
    expect(serialized).not.toContain(seen.cookie); // session never logged
    expect(serialized).not.toContain("synthetic-ui-g"); // subjects never logged
    // Error shells carry the echoed request id for correlation.
    const denied = await fetch(`${base}/w/${randomUUID()}`, { headers: { cookie: seen.cookie } });
    const requestId = denied.headers.get("x-request-id")!;
    expect((await denied.text())).toContain(requestId);
  });

  it("rate limits and readiness gates fail explicitly", async () => {
    const { base } = await startApp({ limits: { mutatingMax: 2 } });
    const { cookie } = await login(base, "synthetic-ui-h");
    const ws = await setupWorkspace(base, cookie, "W");
    const id = await setupAccount(base, cookie, ws, "A");
    // Mutating budget is per-IP (2 used by setup): further POSTs are 429…
    const limited = await fetch(`${base}/api/accounts`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: ws, name: "B" }) });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    // …JSON by default and HTML when the client prefers it.
    const f = form({ accountId: id, name: "Z", expectedVersion: "1", idempotencyKey: randomUUID() });
    const page = await fetch(`${base}/w/${ws}/rename`, { method: "POST", headers: { cookie, origin: base, Accept: "text/html", ...f.headers }, body: f.payload, redirect: "manual" });
    expect(page.status).toBe(429);
    const html = await page.text();
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("<script");
    // Readiness reflects the database; liveness does not depend on it.
    const ok = await startApp({ dbPing: async () => true });
    expect((await (await fetch(`${ok.base}/readyz`)).json())).toMatchObject({ ready: true });
    const down = await startApp({ dbPing: async () => false });
    const unready = await fetch(`${down.base}/readyz`);
    expect(unready.status).toBe(503);
    expect(await unready.json()).toMatchObject({ ready: false });
    expect((await (await fetch(`${down.base}/healthz`)).json())).toMatchObject({ status: "ok" });
  });

  it("controls unit: in-flight cap and windows behave without HTTP", async () => {
    const seen: LogLine[] = [];
    const controls = createControls({ logger: (line) => seen.push(line), maxInflight: 1 });
    const fakeReq = (url: string, method = "GET") => ({ url, method, socket: { remoteAddress: "10.0.0.9" }, headers: {} }) as never;
    const fakeRes = () => {
      const headers: Record<string, string> = {};
      return { setHeader: (k: string, v: string) => (headers[k] = v), headers } as never;
    };
    const first = controls.begin(fakeReq("/api/me"), fakeRes());
    if (!("admitted" in first) || !first.admitted) throw new Error("expected admission");
    const second = controls.begin(fakeReq("/api/me"), fakeRes());
    expect(second).toMatchObject({ admitted: false, reject: 503 });
    controls.finish(first, "GET", "/api/me", 200);
    const third = controls.begin(fakeReq("/api/me"), fakeRes());
    if (!("admitted" in third) || !third.admitted) throw new Error("expected re-admission");
    controls.finish(third, "GET", "/api/me?code=secret", 200);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ method: "GET", path: "/api/me", status: 200 }); // query stripped
  });
});
