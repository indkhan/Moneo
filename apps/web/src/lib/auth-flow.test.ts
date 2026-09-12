import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type AuthConfig } from "./auth-config";
import {
  buildLoginRedirect,
  buildLogoutRedirect,
  completeLogin,
  cookieValue,
} from "./auth-flow";
import { readOAuthState, readSession, seal } from "./session";

const CONFIG: AuthConfig = {
  issuer: "https://moneo.eu.auth0.com",
  loginHost: "https://login.moneo.example",
  clientId: "client-123",
  clientSecret: "secret-abc",
  baseUrl: "http://localhost:3000",
  sessionSecret: "test-session-secret-0123456789",
};

const NOW = 5_000_000;

function fixedRandom() {
  return (bytes: number) => Buffer.alloc(bytes, 0x42);
}

describe("buildLoginRedirect", () => {
  it("targets the custom login host with code + PKCE-S256 parameters", () => {
    const { url, stateSealed } = buildLoginRedirect(CONFIG, { nowSeconds: NOW, random: fixedRandom() });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://login.moneo.example");
    expect(parsed.pathname).toBe("/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("client-123");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback");
    expect(parsed.searchParams.get("scope")).toBe("openid profile email");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");

    const state = parsed.searchParams.get("state");
    expect(state).toBe(Buffer.alloc(32, 0x42).toString("base64url"));
    const saved = readOAuthState(stateSealed, CONFIG.sessionSecret, NOW);
    expect(saved?.state).toBe(state);
    const expectedChallenge = createHash("sha256")
      .update(Buffer.alloc(32, 0x42).toString("base64url"), "utf8")
      .digest()
      .toString("base64url");
    expect(parsed.searchParams.get("code_challenge")).toBe(expectedChallenge);
  });

  it("falls back to the canonical EU host when no custom domain is set", () => {
    const { url } = buildLoginRedirect({ ...CONFIG, loginHost: CONFIG.issuer }, { random: fixedRandom() });
    expect(new URL(url).origin).toBe("https://moneo.eu.auth0.com");
  });

  it("uses fresh randomness per login", () => {
    const first = buildLoginRedirect(CONFIG);
    const second = buildLoginRedirect(CONFIG);
    expect(first.url).not.toBe(second.url);
  });
});

describe("completeLogin", () => {
  const verifier = "verifier-abc";

  function loginSetup(state = "csrf-state-123") {
    const stateCookie = seal({ state, verifier, exp: NOW + 600 }, CONFIG.sessionSecret);
    const exchange = vi.fn(() => Promise.resolve({
      access_token: "server-only-access",
      token_type: "Bearer",
      expires_in: 86_400,
      id_token: "server-only-id-token",
      refresh_token: "server-only-refresh",
    }));
    const fetchProfile = vi.fn(() => Promise.resolve({ sub: "auth0|abc", email: "a@x.com", name: "A" }));
    return { state, stateCookie, exchange, fetchProfile };
  }

  it("seals only profile claims and redirects home on success", async () => {
    const { state, stateCookie, exchange, fetchProfile } = loginSetup();
    const result = await completeLogin({
      config: CONFIG,
      queryState: state,
      queryCode: "auth-code",
      stateCookie,
      nowSeconds: NOW,
      exchange,
      fetchProfile,
    });
    expect(result).toMatchObject({ ok: true, redirectTo: "/home" });
    expect(exchange).toHaveBeenCalledWith("auth-code", verifier, "http://localhost:3000/api/auth/callback");
    expect(fetchProfile).toHaveBeenCalledWith("server-only-access");

    const session = readSession(
      (result as { ok: true; sessionSealed: string }).sessionSealed,
      CONFIG.sessionSecret,
      NOW,
    );
    // Tokens went into the backchannel calls only — never into the cookie.
    expect(session).toMatchObject({ sub: "auth0|abc", email: "a@x.com", name: "A" });
    expect(JSON.stringify(session)).not.toContain("server-only");
  });

  it.each([
    ["missing state cookie", { cookie: null as string | null | undefined, query: "csrf-state-123", code: "c" }],
    ["tampered state cookie", { cookie: "v1.x.y.z", query: "csrf-state-123", code: "c" }],
    ["state mismatch (login CSRF)", { cookie: "valid", query: "forged-state", code: "c" }],
    ["missing state query", { cookie: "valid", query: null, code: "c" }],
    ["missing code", { cookie: "valid", query: "csrf-state-123", code: null }],
  ])("fails closed with invalid_state/invalid_request: %s", async (_label, opts) => {
    const setup = loginSetup();
    const result = await completeLogin({
      config: CONFIG,
      queryState: opts.query,
      queryCode: opts.code,
      stateCookie: opts.cookie === "valid" ? setup.stateCookie : (opts.cookie ?? undefined),
      nowSeconds: NOW,
      exchange: setup.exchange,
      fetchProfile: setup.fetchProfile,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["invalid_state", "invalid_request"]).toContain(result.error);
      expect(result.redirectTo).toBe(`/?auth_error=${result.error}`);
      expect(result.redirectTo).not.toContain("server-only");
    }
    expect(setup.exchange).not.toHaveBeenCalled();
  });

  it("rejects expired state cookies", async () => {
    const setup = loginSetup();
    const result = await completeLogin({
      config: CONFIG,
      queryState: setup.state,
      queryCode: "c",
      stateCookie: setup.stateCookie,
      nowSeconds: NOW + 601,
      exchange: setup.exchange,
      fetchProfile: setup.fetchProfile,
    });
    expect(result).toMatchObject({ ok: false, error: "invalid_state" });
  });

  it("maps exchange failures and empty tokens to exchange_failed", async () => {
    const setup = loginSetup();
    const throwing = { ...setup, exchange: vi.fn(() => Promise.reject(new Error("down"))) };
    const failed = await completeLogin({
      config: CONFIG,
      queryState: setup.state,
      queryCode: "c",
      stateCookie: setup.stateCookie,
      nowSeconds: NOW,
      exchange: throwing.exchange,
      fetchProfile: setup.fetchProfile,
    });
    expect(failed).toMatchObject({ ok: false, error: "exchange_failed", redirectTo: "/?auth_error=exchange_failed" });

    const emptyToken = { ...setup, exchange: vi.fn(() => Promise.resolve({ access_token: "", token_type: "Bearer", expires_in: 1 })) };
    const empty = await completeLogin({
      config: CONFIG,
      queryState: setup.state,
      queryCode: "c",
      stateCookie: setup.stateCookie,
      nowSeconds: NOW,
      exchange: emptyToken.exchange,
      fetchProfile: setup.fetchProfile,
    });
    expect(empty).toMatchObject({ ok: false, error: "exchange_failed" });
  });

  it("maps profile failures and subject-less profiles to profile_failed", async () => {
    const setup = loginSetup();
    const throwing = { ...setup, fetchProfile: vi.fn(() => Promise.reject(new Error("down"))) };
    const failed = await completeLogin({
      config: CONFIG,
      queryState: setup.state,
      queryCode: "c",
      stateCookie: setup.stateCookie,
      nowSeconds: NOW,
      exchange: setup.exchange,
      fetchProfile: throwing.fetchProfile,
    });
    expect(failed).toMatchObject({ ok: false, error: "profile_failed" });

    const noSub = { ...setup, fetchProfile: vi.fn(() => Promise.resolve({ sub: "" })) };
    const empty = await completeLogin({
      config: CONFIG,
      queryState: setup.state,
      queryCode: "c",
      stateCookie: setup.stateCookie,
      nowSeconds: NOW,
      exchange: setup.exchange,
      fetchProfile: noSub.fetchProfile,
    });
    expect(empty).toMatchObject({ ok: false, error: "profile_failed" });
  });
});

describe("buildLogoutRedirect", () => {
  it("ends the IdP session on the EU host and clears both cookies", () => {
    const { url, clearCookie, clearStateCookie } = buildLogoutRedirect(CONFIG);
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://login.moneo.example");
    expect(parsed.pathname).toBe("/v2/logout");
    expect(parsed.searchParams.get("client_id")).toBe("client-123");
    expect(parsed.searchParams.get("returnTo")).toBe("http://localhost:3000");
    expect(clearCookie).toContain("Max-Age=0");
    expect(clearStateCookie).toContain("Max-Age=0");
  });
});

describe("cookieValue", () => {
  it("parses the named cookie out of a header", () => {
    expect(cookieValue("a=1; __Host-moneo_session=sealed; b=2", "__Host-moneo_session")).toBe("sealed");
    expect(cookieValue(null, "__Host-moneo_session")).toBeUndefined();
    expect(cookieValue("", "__Host-moneo_session")).toBeUndefined();
    expect(cookieValue("a=1", "__Host-moneo_session")).toBeUndefined();
    expect(cookieValue("novalue; a=1", "a")).toBe("1");
  });
});
