// E01-S02 deterministic auth contract: stub OIDC issuer (synthetic subs,
// no network beyond loopback), real PostgreSQL disposable database
// (moneo_e01_test, fails closed without PG). No secrets are committed or
// logged; captured tokens/codes must never appear in app responses.

import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, type AuthConfig } from "../apps/web/src/auth.ts";
import { countLiveSessions } from "../apps/web/src/session-store.ts";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
let stubBase = "";

beforeAll(async () => {
  pool = await ensureTestPool("E01-S02", "moneo_e01_test", ["app_sessions"]);
  stub = await startStubIssuer();
  stubBase = stub.base;
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
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
  const accessToken = stub.lastAccessToken();
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
    stub.setEvil(true);
    try {
      const { base, events } = await startApp();
      const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
      expect(start.status).toBe(302);
      expect(start.headers.get("location")).toBe("/");
      expect(events).toContain("auth_login_fail:discovery");
    } finally {
      stub.setEvil(false);
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
