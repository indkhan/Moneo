import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "./auth-session";
import { decideStrongAuth, primaryFactor, requireStrongAuth, StrongAuthError } from "./strong-auth";
import { MfaProviderError, type AuthFactor, type MfaProvider } from "./mfa-provider";

// The official SDK owns cookie cryptography. Stub its session boundary and
// keep the registry/provider checks real.
vi.mock("./auth-session", () => ({
  getSession: () => Promise.resolve(mockedSession),
}));
vi.mock("@moneo/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@moneo/db/sessions", () => ({
  listUserSessions: () => Promise.resolve(mockedRegistry),
}));

// Mutable stub state, reset per test. The mock factories above read these
// bindings lazily at call time (names contain "mock" as vitest requires).
let mockedSession: SessionPayload | null;
let mockedRegistry: Array<{ id: string }>;

function session(): SessionPayload {
  return {
    sub: "auth0|abc",
    uid: "user-1",
    wid: "ws-1",
    sid: "sid-1",
    iat: 1_000,
    exp: 9_999_999_999,
  };
}

function factor(kind: AuthFactor["kind"], confirmed = true): AuthFactor {
  return { id: `${kind}-1`, kind, providerType: kind, confirmed };
}

/** Synthetic provider: scripted factor lists per user, optional outage. */
function syntheticProvider(scripts: Record<string, AuthFactor[] | Error>): MfaProvider {
  return {
    passkeysOffered: () => true,
    listFactors: (userId: string) => {
      const scripted = scripts[userId] ?? [];
      return scripted instanceof Error ? Promise.reject(scripted) : Promise.resolve(scripted);
    },
    enrollmentTicket: () => Promise.resolve({ ticketUrl: "https://moneo.eu.auth0.com/enroll/x" }),
  };
}

describe("primaryFactor", () => {
  it("accepts any confirmed primary factor, never recovery codes alone", () => {
    expect(primaryFactor([factor("recovery-code")])).toBeNull();
    expect(primaryFactor([])).toBeNull();
    expect(primaryFactor([factor("totp", false), factor("recovery-code")])).toBeNull();
    expect(primaryFactor([factor("recovery-code"), factor("totp")])?.kind).toBe("totp");
    expect(primaryFactor([factor("passkey")])?.kind).toBe("passkey");
  });

  it.each(["sms", "email", "guardian"] as const)("does not treat %s as a strong factor", (kind) => {
    expect(primaryFactor([factor(kind)])).toBeNull();
  });
});

describe("decideStrongAuth", () => {
  const s = session();

  it("enrolls via the passkey path", () => {
    const status = decideStrongAuth(s, true, [factor("passkey")], false, true);
    expect(status).toMatchObject({ state: "enrolled", method: "passkey" });
  });

  it("enrolls via the TOTP fallback path", () => {
    const status = decideStrongAuth(
      s,
      true,
      [factor("recovery-code"), factor("totp")],
      false,
      false,
    );
    expect(status).toMatchObject({ state: "enrolled", method: "totp" });
  });

  it("keeps fresh users locked until a primary factor verifies", () => {
    expect(decideStrongAuth(s, true, [], false, true).state).toBe("not-enrolled");
    expect(decideStrongAuth(s, true, [factor("recovery-code")], false, true).state).toBe(
      "not-enrolled",
    );
    expect(decideStrongAuth(s, true, [factor("totp", false)], false, true).state).toBe(
      "not-enrolled",
    );
    // Unconfirmed passkey + nothing else: still locked.
    expect(decideStrongAuth(s, true, [factor("passkey", false)], false, true).state).toBe(
      "not-enrolled",
    );
  });

  it("fails closed on provider outage — degraded is never enrolled", () => {
    const status = decideStrongAuth(s, true, null, true, true);
    expect(status.state).toBe("degraded");
    expect(status.method).toBeNull();
  });

  it("treats missing sessions and revoked sessions as signed out", () => {
    expect(decideStrongAuth(null, false, null, false, true).state).toBe("signed-out");
    expect(decideStrongAuth(s, false, [factor("passkey")], false, true).state).toBe("signed-out");
  });

  it("surfaces offered factors and the passkey capability for the UI", () => {
    const factors = [factor("totp")];
    const status = decideStrongAuth(s, true, factors, false, false);
    expect(status.factors).toBe(factors);
    expect(status.passkeysOffered).toBe(false);
  });
});

describe("requireStrongAuth gate (mocked cookie + registry)", () => {
  beforeEach(() => {
    mockedRegistry = [];
    mockedSession = { ...session(), sid: "sid-live" };
  });

  afterEach(() => {
    mockedSession = null;
    mockedRegistry = [];
  });

  it("lets an enrolled live session through with its status", async () => {
    mockedRegistry = [{ id: "sid-live" }];
    const provider = syntheticProvider({ "auth0|abc": [factor("passkey")] });
    const ctx = await requireStrongAuth(provider);
    expect(ctx.session.sub).toBe("auth0|abc");
    expect(ctx.status).toMatchObject({ state: "enrolled", method: "passkey" });
  });

  it("denies a fresh user (NOT_ENROLLED): no direct-API bypass", async () => {
    mockedRegistry = [{ id: "sid-live" }];
    const provider = syntheticProvider({ "auth0|abc": [] });
    await expect(requireStrongAuth(provider)).rejects.toMatchObject({
      name: "StrongAuthError",
      code: "NOT_ENROLLED",
    });
  });

  it("denies revoked sessions (SIGNED_OUT) even with enrolled factors", async () => {
    mockedRegistry = [];
    const provider = syntheticProvider({ "auth0|abc": [factor("passkey")] });
    await expect(requireStrongAuth(provider)).rejects.toMatchObject({ code: "SIGNED_OUT" });
  });

  it("denies missing SDK sessions (SIGNED_OUT)", async () => {
    mockedSession = null;
    mockedRegistry = [{ id: "sid-live" }];
    const provider = syntheticProvider({ "auth0|abc": [factor("passkey")] });
    await expect(requireStrongAuth(provider)).rejects.toMatchObject({ code: "SIGNED_OUT" });
  });

  it("denies missing sessions and degraded providers without unlocking", async () => {
    mockedSession = null;
    await expect(requireStrongAuth(syntheticProvider({}))).rejects.toMatchObject({
      code: "SIGNED_OUT",
    });

    mockedSession = { ...session(), sid: "sid-live" };
    mockedRegistry = [{ id: "sid-live" }];
    const outage = syntheticProvider({ "auth0|abc": new MfaProviderError("UNAVAILABLE", "down") });
    await expect(requireStrongAuth(outage)).rejects.toMatchObject({ code: "DEGRADED" });
  });

  it("exposes SIGNED_OUT / NOT_ENROLLED / DEGRADED codes", () => {
    for (const code of ["SIGNED_OUT", "NOT_ENROLLED", "DEGRADED"] as const) {
      expect(new StrongAuthError(code, "msg").code).toBe(code);
    }
  });
});
