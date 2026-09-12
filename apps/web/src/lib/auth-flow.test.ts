import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type AuthConfig } from "./auth-config";
import { buildLoginRedirect, buildLogoutRedirect, completeLogin } from "./auth-flow";
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
    const { url, stateSealed } = buildLoginRedirect(CONFIG, {
      nowSeconds: NOW,
      random: fixedRandom(),
    });
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
    const { url } = buildLoginRedirect(
      { ...CONFIG, loginHost: CONFIG.issuer },
      { random: fixedRandom() },
    );
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
    const exchange = vi.fn(() =>
      Promise.resolve({
        access_token: "server-only-access",
        token_type: "Bearer",
        expires_in: 86_400,
        id_token: "server-only-id-token",
        refresh_token: "server-only-refresh",
      }),
    );
    const fetchProfile = vi.fn(() =>
      Promise.resolve({ sub: "auth0|abc", email: "a@x.com", name: "A" }),
    );
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
    expect(exchange).toHaveBeenCalledWith(
      "auth-code",
      verifier,
      "http://localhost:3000/api/auth/callback",
    );
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
    [
      "missing state cookie",
      { cookie: null as string | null | undefined, query: "csrf-state-123", code: "c" },
    ],
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
    expect(failed).toMatchObject({
      ok: false,
      error: "exchange_failed",
      redirectTo: "/?auth_error=exchange_failed",
    });

    const emptyToken = {
      ...setup,
      exchange: vi.fn(() =>
        Promise.resolve({ access_token: "", token_type: "Bearer", expires_in: 1 }),
      ),
    };
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

describe("completeLogin provisioning hook (Issue 1.4)", () => {
  const verifier = "verifier-abc";

  function setup(state = "csrf-state-123") {
    const stateCookie = seal({ state, verifier, exp: NOW + 600 }, CONFIG.sessionSecret);
    const exchange = vi.fn(() =>
      Promise.resolve({
        access_token: "server-only-access",
        token_type: "Bearer",
        expires_in: 86_400,
      }),
    );
    const fetchProfile = vi.fn(() => Promise.resolve({ sub: "auth0|abc", email: "a@x.com" }));
    return { state, stateCookie, exchange, fetchProfile };
  }

  function loginInput(
    s: ReturnType<typeof setup>,
    provision?: (profile: { sub: string }) => Promise<{ uid: string; wid: string } | null>,
  ) {
    return {
      config: CONFIG,
      queryState: s.state,
      queryCode: "auth-code",
      stateCookie: s.stateCookie,
      nowSeconds: NOW,
      exchange: s.exchange,
      fetchProfile: s.fetchProfile,
      ...(provision ? { provision } : {}),
    };
  }

  it("attaches uid/wid to the session when provisioning succeeds", async () => {
    const s = setup();
    const provision = vi.fn(() => Promise.resolve({ uid: "user-1", wid: "ws-1" }));
    const result = await completeLogin(loginInput(s, provision));
    expect(result.ok).toBe(true);
    expect(provision).toHaveBeenCalledWith({ sub: "auth0|abc", email: "a@x.com" });
    const session = readSession(
      (result as { ok: true; sessionSealed: string }).sessionSealed,
      CONFIG.sessionSecret,
      NOW,
    );
    expect(session).toMatchObject({ sub: "auth0|abc", uid: "user-1", wid: "ws-1" });
  });

  it("fails closed when provisioning returns null, throws or yields bad ids", async () => {
    const s = setup();
    for (const provision of [
      () => Promise.resolve(null),
      () => Promise.reject(new Error("db down")),
      () => Promise.resolve({ uid: "", wid: "ws-1" }),
      () => Promise.resolve({ uid: "user-1", wid: 42 }),
    ]) {
      const result = await completeLogin(
        loginInput(
          s,
          provision as (profile: { sub: string }) => Promise<{ uid: string; wid: string } | null>,
        ),
      );
      expect(result).toMatchObject({ ok: false, error: "provisioning_failed" });
      if (!result.ok) {
        expect(result.redirectTo).toBe("/?auth_error=provisioning_failed");
      }
    }
  });

  it("mints sessions without uid/wid when no provision hook is wired", async () => {
    const s = setup();
    const result = await completeLogin(loginInput(s));
    expect(result.ok).toBe(true);
    const session = readSession(
      (result as { ok: true; sessionSealed: string }).sessionSealed,
      CONFIG.sessionSecret,
      NOW,
    );
    expect(session).toMatchObject({ sub: "auth0|abc" });
    expect(session).not.toHaveProperty("uid");
    expect(session).not.toHaveProperty("wid");
  });
});

describe("completeLogin session registration (Issue 1.7)", () => {
  const verifier = "verifier-abc";

  function setup() {
    const stateCookie = seal(
      { state: "csrf-state-123", verifier, exp: NOW + 600 },
      CONFIG.sessionSecret,
    );
    const exchange = vi.fn(() =>
      Promise.resolve({
        access_token: "server-only-access",
        token_type: "Bearer",
        expires_in: 86_400,
      }),
    );
    const fetchProfile = vi.fn(() => Promise.resolve({ sub: "auth0|abc" }));
    const provision = vi.fn(() => Promise.resolve({ uid: "user-1", wid: "ws-1" }));
    return { stateCookie, exchange, fetchProfile, provision };
  }

  function input(s: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) {
    return {
      config: CONFIG,
      queryState: "csrf-state-123",
      queryCode: "auth-code",
      stateCookie: s.stateCookie,
      nowSeconds: NOW,
      exchange: s.exchange,
      fetchProfile: s.fetchProfile,
      provision: s.provision,
      ...extra,
    };
  }

  it("registers the login with the sealed sid and returns the ids", async () => {
    const s = setup();
    const registerSession = vi.fn(
      (args: { sid: string; uid: string; wid: string; userAgent: string | null }) =>
        Promise.resolve(args),
    );
    const result = await completeLogin(input(s, { userAgent: "TestBrowser/9", registerSession }));
    expect(result.ok).toBe(true);
    expect(s.provision).toHaveBeenCalledOnce();
    expect(registerSession).toHaveBeenCalledOnce();
    const args = registerSession.mock.calls[0]?.[0];
    expect(args).toMatchObject({ uid: "user-1", wid: "ws-1", userAgent: "TestBrowser/9" });
    expect(typeof args?.sid).toBe("string");
    const ok = result as {
      ok: true;
      sid: string;
      uid: string | null;
      wid: string | null;
      sessionSealed: string;
    };
    expect(ok.sid).toBe(args?.sid);
    expect(ok.uid).toBe("user-1");
    expect(ok.wid).toBe("ws-1");
    // The sealed cookie carries the same sid the registry holds.
    expect(readSession(ok.sessionSealed, CONFIG.sessionSecret, NOW)?.sid).toBe(args?.sid);
  });

  it("fails closed when registration rejects", async () => {
    const s = setup();
    const result = await completeLogin(
      input(s, { registerSession: () => Promise.reject(new Error("registry down")) }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: "session_failed",
      redirectTo: "/?auth_error=session_failed",
    });
  });

  it("skips registration when no provision ran (no uid/wid to register)", async () => {
    const s = setup();
    const registerSession = vi.fn(() => Promise.resolve(undefined));
    const { provision: _provision, ...withoutProvision } = input(s);
    const result = await completeLogin({ ...withoutProvision, registerSession });
    expect(result.ok).toBe(true);
    expect(registerSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ uid: null, wid: null });
  });

  it("forwards a null user agent instead of dropping registration", async () => {
    const s = setup();
    const registerSession = vi.fn(() => Promise.resolve(undefined));
    const result = await completeLogin(input(s, { userAgent: null, registerSession }));
    expect(result.ok).toBe(true);
    expect(registerSession).toHaveBeenCalledWith(expect.objectContaining({ userAgent: null }));
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
