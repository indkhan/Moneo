// E01-S02 Keycloak Authorization Code + S256 PKCE with server-checked app
// sessions. Tokens, codes and verifiers live only in this exchange; they are
// never stored, logged, or echoed. User identity comes from the back-channel
// userinfo endpoint of a discovery-validated issuer (exact issuer match per
// OIDC Discovery 4.3, same-origin endpoints) — no local JWT parsing, so no
// JWT library is needed. Pending logins are single-use, in-memory and
// TTL-bounded (single-instance limit documented in STORIES.md E01-S02).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createSession, readSession, revokeSession } from "./session-store.ts";

export type AuthConfig = {
  issuer: string; // exact issuer identifier, e.g. http://127.0.0.1:8080/realms/moneo
  clientId: string;
  clientSecret: string; // confidential client secret; required, never empty in this slice
  appBaseUrl: string; // e.g. http://127.0.0.1:3000 — origin allowlist + Secure-cookie switch
  sessionSecret: string; // HMAC key; server refuses to start auth without it
  sessionTtlSec: number;
  onEvent?: (code: string) => void;
};

export type Discovery = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
};

const SESSION_COOKIE = "moneo_session";
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 1000;

function base64url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function sameOrigin(a: string, b: string): boolean {
  return new URL(a).origin === new URL(b).origin;
}

export async function loadDiscovery(issuer: string): Promise<Discovery> {
  const normalized = issuer.replace(/\/+$/, "");
  const res = await fetch(`${normalized}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`discovery_unreachable:${res.status}`);
  const doc = (await res.json()) as {
    issuer?: string;
    authorization_endpoint?: string;
    token_endpoint?: string;
    userinfo_endpoint?: string;
  };
  if (doc.issuer !== normalized) throw new Error("discovery_issuer_mismatch");
  for (const key of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint"] as const) {
    if (typeof doc[key] !== "string" || !sameOrigin(doc[key], normalized)) throw new Error(`discovery_endpoint_${key}`);
  }
  return {
    authorizationEndpoint: doc.authorization_endpoint as string,
    tokenEndpoint: doc.token_endpoint as string,
    userinfoEndpoint: doc.userinfo_endpoint as string,
  };
}

function safeReturnTo(value: string | null): string {
  if (!value) return "/";
  // Control characters would make the callback redirect throw after the
  // session is already created; reject them up front so hostile input never
  // reaches the redirect and can never mint-then-fail a session.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("://")) return "/";
  return value;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function sessionCookieValue(id: string, secret: string): string {
  return `${id}.${createHmac("sha256", secret).update(id).digest("hex")}`;
}

function verifySessionCookie(value: string | undefined, secret: string): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const id = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(id) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const expected = createHmac("sha256", secret).update(id).digest();
  const actual = Buffer.from(sig, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return id;
}

function setSessionCookie(res: ServerResponse, config: AuthConfig, id: string | null, maxAgeSec: number): void {
  const secure = config.appBaseUrl.startsWith("https://") ? "; Secure" : "";
  const value = id === null ? "expired" : sessionCookieValue(id, config.sessionSecret);
  const age = id === null ? "Max-Age=0" : `Max-Age=${maxAgeSec}`;
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax${secure}; ${age}`);
}

export type AuthRouter = {
  handle: (req: IncomingMessage, res: ServerResponse, path: string, method: string, query: URLSearchParams) => Promise<boolean>;
};

export function createAuthRouter(config: AuthConfig, pool: Pool): AuthRouter {
  if (!config.sessionSecret) throw new Error("E01-S02 refused: SESSION_SECRET is required.");
  if (!config.issuer || !config.clientId || !config.appBaseUrl) throw new Error("E01-S02 refused: issuer, clientId and appBaseUrl are required.");
  if (!config.clientSecret) throw new Error("E01-S02 refused: confidential client secret is required (public clients are not admitted in this slice).");
  if (config.issuer !== config.issuer.replace(/\/+$/, "")) throw new Error("E01-S02 refused: issuer must be exact with no trailing slash.");
  try {
    void new URL(config.issuer);
    void new URL(config.appBaseUrl);
  } catch {
    throw new Error("E01-S02 refused: issuer and appBaseUrl must be valid absolute URLs.");
  }
  const event = config.onEvent ?? (() => {});
  // Read per request: tests bind an ephemeral port after constructing the
  // router and then set config.appBaseUrl to the live base URL.
  const redirectUri = (): string => `${config.appBaseUrl.replace(/\/+$/, "")}/auth/callback`;
  let discovery: Discovery | null = null;
  const pending = new Map<string, { verifier: string; returnTo: string; created: number }>();

  async function discovered(): Promise<Discovery> {
    if (!discovery) discovery = await loadDiscovery(config.issuer);
    return discovery;
  }

  function sweepPending(): void {
    if (pending.size === 0) return;
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [state, entry] of pending) {
      if (entry.created < cutoff) pending.delete(state);
    }
    while (pending.size > MAX_PENDING) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      pending.delete(oldest.value);
    }
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    res.end(payload);
  }

  function failClosed(res: ServerResponse, reason: string): void {
    event(`auth_callback_fail:${reason}`);
    res.writeHead(302, { Location: "/" });
    res.end();
  }

  async function handleLogin(res: ServerResponse, query: URLSearchParams): Promise<void> {
    sweepPending();
    let disc: Discovery;
    try {
      disc = await discovered();
    } catch {
      event("auth_login_fail:discovery");
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }
    const state = base64url(32);
    const verifier = base64url(48);
    pending.set(state, { verifier, returnTo: safeReturnTo(query.get("returnTo")), created: Date.now() });
    const url = new URL(disc.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("scope", "openid");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", s256(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    event("auth_login_start");
    res.writeHead(302, { Location: url.toString() });
    res.end();
  }

  async function handleCallback(res: ServerResponse, query: URLSearchParams): Promise<void> {
    const state = query.get("state");
    const code = query.get("code");
    const entry = state ? pending.get(state) : undefined;
    if (state) pending.delete(state); // single-use: consumed on first attempt
    if (!state || !code || !entry) {
      failClosed(res, !state || !entry ? "state" : "code");
      return;
    }
    if (Date.now() - entry.created > PENDING_TTL_MS) {
      failClosed(res, "expired");
      return;
    }
    let disc: Discovery;
    try {
      disc = await discovered();
    } catch {
      failClosed(res, "discovery");
      return;
    }
    try {
      const form: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(),
        client_id: config.clientId,
        code_verifier: entry.verifier,
      };
      if (config.clientSecret) form["client_secret"] = config.clientSecret;
      const tokenRes = await fetch(disc.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(30_000),
      });
      if (!tokenRes.ok) {
        failClosed(res, "exchange");
        return;
      }
      const tokens = (await tokenRes.json()) as { access_token?: string; token_type?: string };
      if (typeof tokens.access_token !== "string" || !tokens.access_token) {
        failClosed(res, "tokens");
        return;
      }
      const userRes = await fetch(disc.userinfoEndpoint, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!userRes.ok) {
        failClosed(res, "userinfo");
        return;
      }
      const claims = (await userRes.json()) as { sub?: string };
      if (typeof claims.sub !== "string" || !claims.sub) {
        failClosed(res, "sub");
        return;
      }
      const session = await createSession(pool, claims.sub, config.sessionTtlSec);
      setSessionCookie(res, config, session.id, config.sessionTtlSec);
      event("auth_login_ok");
      res.writeHead(302, { Location: entry.returnTo });
      res.end();
    } catch {
      failClosed(res, "error");
    }
  }

  async function handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const allowed = new URL(config.appBaseUrl).origin;
    const originOk = typeof origin === "string" ? origin === allowed : false;
    const refererOk = typeof origin !== "string" && typeof referer === "string" ? referer.startsWith(`${allowed}/`) || referer === allowed : false;
    if (!originOk && !refererOk) {
      event("auth_logout_denied:origin");
      json(res, 403, { error: "forbidden" });
      return;
    }
    const id = verifySessionCookie(parseCookies(req)[SESSION_COOKIE], config.sessionSecret);
    if (id) await revokeSession(pool, id);
    setSessionCookie(res, config, null, 0);
    event("auth_logout_ok");
    json(res, 200, { ok: true });
  }

  async function handleMe(req: IncomingMessage, res: ServerResponse, headOnly: boolean): Promise<void> {
    const id = verifySessionCookie(parseCookies(req)[SESSION_COOKIE], config.sessionSecret);
    const session = id ? await readSession(pool, id) : null;
    event(session ? "auth_ok:me" : "auth_denied:me");
    if (!session) setSessionCookie(res, config, null, 0);
    const body = session
      ? { sub: session.keycloakSub, issuedAt: session.createdAt, expiresAt: session.expiresAt }
      : { error: "unauthorized" };
    if (headOnly) {
      res.writeHead(session ? 200 : 401, {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      });
      res.end();
      return;
    }
    json(res, session ? 200 : 401, body);
  }

  return {
    handle: async (req, res, path, method, query) => {
      if (path === "/auth/login" && method === "GET") {
        await handleLogin(res, query);
        return true;
      }
      if (path === "/auth/callback" && method === "GET") {
        await handleCallback(res, query);
        return true;
      }
      if (path === "/auth/logout" && method === "POST") {
        await handleLogout(req, res);
        return true;
      }
      if (path === "/api/me" && (method === "GET" || method === "HEAD")) {
        await handleMe(req, res, method === "HEAD");
        return true;
      }
      return false;
    },
  };
}
