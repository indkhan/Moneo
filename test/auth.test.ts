// E01-S02 deterministic auth contract: stub OIDC issuer (synthetic subs,
// no network beyond loopback), real PostgreSQL disposable database
// (moneo_e01_test, fails closed without PG). No secrets are committed or
// logged; captured tokens/codes must never appear in app responses.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, type AuthConfig } from "../apps/web/src/auth.ts";
import { createPool, migrate, withDatabase } from "../apps/web/src/db.ts";
import { countLiveSessions } from "../apps/web/src/session-store.ts";

// ---- disposable database (same guard convention as the E00 durable proof) ----

const TEST_DB = "moneo_e01_test";

function env(name: string): string {
  // Mirror the E00 proof convention: process env first, repo .env fallback.
  // Values are never logged; failures name only the missing variable.
  let value = process.env[name];
  if (!value) {
    try {
      for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m?.[1] === name) {
          value = m[2].replace(/^['"]|['"]$/g, "");
          break;
        }
      }
    } catch { /* no .env file */ }
  }
  if (!value) throw new Error(`E01-S02 prerequisite missing: ${name} (local disposable PostgreSQL).`);
  return value;
}

let pool: Pool;

async function ensureTestDatabase(): Promise<void> {
  const appUrl = env("DATABASE_URL");
  let setupUrl = process.env["DATABASE_MIGRATION_URL"];
  if (!setupUrl) {
    try {
      setupUrl = env("DATABASE_MIGRATION_URL");
    } catch {
      setupUrl = appUrl;
    }
  }
  const appDb = new URL(appUrl).pathname.replace("/", "");
  if (TEST_DB === appDb || ["postgres", "template0", "template1"].includes(TEST_DB)) {
    throw new Error("E01-S02 refused: test database must be disposable.");
  }
  const setup = new Pool({ connectionString: setupUrl, connectionTimeoutMillis: 8000 });
  try {
    const found = await setup.query("SELECT 1 FROM pg_database WHERE datname = $1", [TEST_DB]);
    if (found.rowCount === 0) {
      const appUser = decodeURIComponent(new URL(appUrl).username);
      if (!/^[A-Za-z_][A-Za-z0-9_@$]*$/.test(appUser)) throw new Error("E01-S02 refused: app-role username is not a safe SQL identifier.");
      await setup.query(`CREATE DATABASE "${TEST_DB}" OWNER "${appUser}"`);
    }
  } finally {
    await setup.end();
  }
  pool = createPool(withDatabase(appUrl, TEST_DB));
  await migrate(pool, "apps/web/migrations");
  await pool.query("TRUNCATE app_sessions");
}

// ---- stub OIDC issuer ----

type StubCode = { challenge: string; clientId: string; redirectUri: string; sub: string; used: boolean };

let stub: Server;
let stubBase = "";
let evilIssuer = false;
const codes = new Map<string, StubCode>();
const accessToSub = new Map<string, string>();
const STUB_CLIENT_SECRET = "stub-secret";

function stubJson(res: ServerResponse, status: number, body: unknown, location?: string): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...(location ? { Location: location } : {}),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

beforeAll(async () => {
  await ensureTestDatabase();
  stub = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub.invalid");
    if (url.pathname === "/.well-known/openid-configuration") {
      stubJson(res, 200, {
        issuer: evilIssuer ? "http://evil.invalid/realms/moneo" : stubBase,
        authorization_endpoint: `${stubBase}/authorize`,
        token_endpoint: `${stubBase}/token`,
        userinfo_endpoint: `${stubBase}/userinfo`,
      });
      return;
    }
    if (url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const challenge = url.searchParams.get("code_challenge");
      const method = url.searchParams.get("code_challenge_method");
      const state = url.searchParams.get("state");
      if (clientId !== "moneo-test-client" || !redirectUri?.endsWith("/auth/callback") || !challenge || method !== "S256" || !state) {
        stubJson(res, 400, { error: "invalid_request" });
        return;
      }
      const code = randomBytes(24).toString("base64url");
      codes.set(code, { challenge, clientId, redirectUri, sub: url.searchParams.get("login_as") ?? "synthetic-user-a", used: false });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(await readBody(req));
      const code = body.get("code") ?? "";
      const entry = codes.get(code);
      const verifier = body.get("code_verifier") ?? "";
      const expected = createHash("sha256").update(verifier).digest("base64url");
      if (body.get("grant_type") !== "authorization_code" || !entry || entry.used || entry.challenge !== expected || body.get("client_id") !== entry.clientId || body.get("redirect_uri") !== entry.redirectUri || body.get("client_secret") !== STUB_CLIENT_SECRET) {
        stubJson(res, 400, { error: "invalid_grant" });
        return;
      }
      entry.used = true;
      const access = `stub-access-${randomBytes(16).toString("hex")}`;
      accessToSub.set(access, entry.sub);
      stubJson(res, 200, { access_token: access, token_type: "Bearer", expires_in: 300 });
      return;
    }
    if (url.pathname === "/userinfo") {
      const sub = accessToSub.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!sub) {
        stubJson(res, 401, { error: "invalid_token" });
        return;
      }
      stubJson(res, 200, { sub });
      return;
    }
    stubJson(res, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (stub) await new Promise<void>((resolve) => stub.close(() => resolve()));
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

// ---- app harness ----

const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");

async function startApp(overrides: Partial<AuthConfig> = {}): Promise<{ base: string; events: string[] }> {
  const events: string[] = [];
  const config: AuthConfig = {
    issuer: stubBase,
    clientId: "moneo-test-client",
    clientSecret: STUB_CLIENT_SECRET,
    appBaseUrl: "http://127.0.0.1:1",
    sessionSecret,
    sessionTtlSec: 43200,
    onEvent: (code) => events.push(code),
    ...overrides,
  };
  const final = createApp(createAuthRouter(config, pool));
  await new Promise<void>((resolve) => final.listen(0, "127.0.0.1", resolve));
  appServers.push(final);
  const base = `http://127.0.0.1:${(final.address() as AddressInfo).port}`;
  config.appBaseUrl = base; // the router reads this lazily per request
  return { base, events };
}

/** Drive the full login dance; returns the session cookie and captured secrets. */
async function login(base: string, loginAs = "synthetic-user-a", returnTo?: string): Promise<{ cookie: string; code: string; accessToken: string }> {
  const start = await fetch(`${base}/auth/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`, { redirect: "manual" });
  expect(start.status).toBe(302);
  const authorizeUrl = start.headers.get("location")!;
  expect(authorizeUrl.startsWith(`${stubBase}/authorize`)).toBe(true);
  const authed = await fetch(`${authorizeUrl}&login_as=${loginAs}`, { redirect: "manual" });
  expect(authed.status).toBe(302);
  const callbackUrl = authed.headers.get("location")!;
  const code = new URL(callbackUrl).searchParams.get("code")!;
  const done = await fetch(callbackUrl, { redirect: "manual" });
  expect(done.status).toBe(302);
  const cookie = done.headers.get("set-cookie")!;
  // Recover the stub access token bound to this code for leak assertions.
  const accessToken = [...accessToSub.entries()].at(-1)?.[0] ?? "";
  return { cookie: cookie.split(";")[0], code, accessToken };
}

describe("e01-s02 auth and revocation", () => {
  it("login issues an opaque session cookie and /api/me returns the sub", async () => {
    const { base } = await startApp();
    const { cookie, code, accessToken } = await login(base);
    expect(cookie).toMatch(/^moneo_session=[0-9a-f]{64}\.[0-9a-f]{64}$/);
    expect(cookie).not.toContain("synthetic-user-a");
    const me = await fetch(`${base}/api/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ sub: "synthetic-user-a" });
    const raw = await (await fetch(`${base}/api/me`, { headers: { cookie } })).text();
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(accessToken);
  });

  it("session cookie carries HttpOnly/SameSite/Path flags", async () => {
    const { base } = await startApp();
    const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
    const callbackUrl = (await fetch(`${start.headers.get("location")!}`, { redirect: "manual" })).headers.get("location")!;
    const done = await fetch(callbackUrl, { redirect: "manual" });
    const setCookie = done.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
  });

  it("logout revokes: API and reconnect fail closed with no token material", async () => {
    const { base } = await startApp();
    const { cookie } = await login(base);
    const out = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie, origin: base } });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });
    for (let i = 0; i < 2; i++) {
      const me = await fetch(`${base}/api/me`, { headers: { cookie } });
      expect(me.status).toBe(401);
      expect(await me.json()).toEqual({ error: "unauthorized" });
    }
    // Double logout stays idempotent.
    const again = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie, origin: base } });
    expect(again.status).toBe(200);
  });

  it("two users are isolated: revoking A leaves B live", async () => {
    const { base } = await startApp();
    const a = await login(base, "synthetic-user-a");
    const b = await login(base, "synthetic-user-b");
    await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: a.cookie, origin: base } });
    expect((await fetch(`${base}/api/me`, { headers: { cookie: a.cookie } })).status).toBe(401);
    const meB = await fetch(`${base}/api/me`, { headers: { cookie: b.cookie } });
    expect(meB.status).toBe(200);
    expect(await meB.json()).toMatchObject({ sub: "synthetic-user-b" });
  });

  it("expired sessions fail on API and reconnect", async () => {
    const { base } = await startApp({ sessionTtlSec: 1 });
    const { cookie } = await login(base);
    expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(401);
    expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(401);
  });

  it("forged, missing and replayed state fail without creating sessions", async () => {
    const { base, events } = await startApp();
    const before = await countLiveSessions(pool);
    // Missing state.
    const noState = await fetch(`${base}/auth/callback?code=anything`, { redirect: "manual" });
    expect(noState.status).toBe(302);
    expect(noState.headers.get("location")).toBe("/");
    // Forged state.
    const forged = await fetch(`${base}/auth/callback?code=x&state=${randomBytes(16).toString("base64url")}`, { redirect: "manual" });
    expect(forged.status).toBe(302);
    // Replay: consume a real state once, then reuse it.
    const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
    const authorizeUrl = start.headers.get("location")!;
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const first = await fetch((await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!, { redirect: "manual" });
    expect(first.status).toBe(302);
    const replay = await fetch(`${base}/auth/callback?code=reused&state=${state}`, { redirect: "manual" });
    expect(replay.status).toBe(302);
    expect(await countLiveSessions(pool)).toBe(before + 1); // only the first, legitimate login
    expect(events.filter((e) => e.startsWith("auth_callback_fail"))).not.toHaveLength(0);
  });

  it("evil issuer discovery (iss mismatch) refuses the login", async () => {
    evilIssuer = true;
    try {
      const { base, events } = await startApp();
      const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
      expect(start.status).toBe(302);
      expect(start.headers.get("location")).toBe("/");
      expect(events).toContain("auth_login_fail:discovery");
    } finally {
      evilIssuer = false;
    }
  });

  it("absolute and protocol-relative redirects fall back to /", async () => {
    const { base } = await startApp();
    for (const target of ["https://evil.invalid/", "//evil.invalid/", "\\\\evil", "javascript:alert(1)"]) {
      const { cookie } = await login(base, "synthetic-user-a", target);
      expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(200);
    }
    const start = await fetch(`${base}/auth/login?returnTo=${encodeURIComponent("https://evil.invalid/")}`, { redirect: "manual" });
    const callbackUrl = (await fetch(start.headers.get("location")!, { redirect: "manual" })).headers.get("location")!;
    const done = await fetch(callbackUrl, { redirect: "manual" });
    expect(done.headers.get("location")).toBe("/");
  });

  it("cross-origin and origin-less logout are denied; tampered cookies fail indistinguishably", async () => {
    const { base } = await startApp();
    const { cookie } = await login(base);
    const cross = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie, origin: "https://evil.invalid" } });
    expect(cross.status).toBe(403);
    const none = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie } });
    expect(none.status).toBe(403);
    // Session survives the denied attempts.
    expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(200);
    // Tampered signature and unknown id give the same 401 body as revocation.
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("0") ? "1" : "0"}`;
    for (const candidate of [tampered, "moneo_session=not-hex", `moneo_session=${"a".repeat(64)}.${"b".repeat(64)}`]) {
      const res = await fetch(`${base}/api/me`, { headers: { cookie: candidate } });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("control-character redirects fall back to / without mint-then-fail sessions", async () => {
    const { base } = await startApp();
    const before = await countLiveSessions(pool);
    const start = await fetch(`${base}/auth/login?returnTo=${encodeURIComponent("/x\r\nSet-Cookie: evil=1")}`, { redirect: "manual" });
    const callbackUrl = (await fetch(start.headers.get("location")!, { redirect: "manual" })).headers.get("location")!;
    const done = await fetch(callbackUrl, { redirect: "manual" });
    expect(done.headers.get("location")).toBe("/");
    expect(await countLiveSessions(pool)).toBe(before + 1); // legitimate login, sanitized landing
  });

  it("HEAD /api/me matches GET semantics and clears dead cookies", async () => {
    const { base } = await startApp();
    const { cookie } = await login(base);
    expect((await fetch(`${base}/api/me`, { method: "HEAD", headers: { cookie } })).status).toBe(200);
    await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie, origin: base } });
    const head = await fetch(`${base}/api/me`, { method: "HEAD", headers: { cookie } });
    expect(head.status).toBe(401);
    expect(head.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("misconfigured issuers and public clients are refused at router construction", async () => {
    expect(() => createAuthRouter({ issuer: `${stubBase}/`, clientId: "moneo-test-client", clientSecret: STUB_CLIENT_SECRET, appBaseUrl: "http://127.0.0.1:1", sessionSecret, sessionTtlSec: 60 }, pool)).toThrow(/trailing slash/);
    expect(() => createAuthRouter({ issuer: stubBase, clientId: "moneo-test-client", clientSecret: "", appBaseUrl: "http://127.0.0.1:1", sessionSecret, sessionTtlSec: 60 }, pool)).toThrow(/confidential client secret/);
    expect(() => createAuthRouter({ issuer: stubBase, clientId: "moneo-test-client", clientSecret: STUB_CLIENT_SECRET, appBaseUrl: "http://127.0.0.1:1", sessionSecret: "", sessionTtlSec: 60 }, pool)).toThrow(/SESSION_SECRET/);
  });

  it("unconfigured app answers 503 without auth behavior", async () => {
    const bare = createApp(null);
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    appServers.push(bare);
    const base = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    expect((await (await fetch(`${base}/api/me`)).json())).toEqual({ error: "auth_not_configured" });
  });
});
