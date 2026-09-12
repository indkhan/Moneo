import { describe, expect, it } from "vitest";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  assertNoTokenMaterial,
  buildSessionPayload,
  oauthStateClearCookie,
  oauthStateSetCookie,
  readOAuthState,
  readSession,
  seal,
  sessionClearCookie,
  sessionSetCookie,
  statesMatch,
  unseal,
} from "./session";

const SECRET = "test-session-secret-0123456789abcdef";
const OTHER_SECRET = "a-different-secret-0123456789abcdef";

describe("seal/unseal envelope", () => {
  it("round-trips JSON through AES-256-GCM", () => {
    const sealed = seal({ sub: "auth0|abc", n: 7 }, SECRET);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(unseal(sealed, SECRET)).toEqual({ sub: "auth0|abc", n: 7 });
  });

  it("produces a fresh IV per call so identical payloads differ", () => {
    expect(seal({ a: 1 }, SECRET)).not.toBe(seal({ a: 1 }, SECRET));
  });

  it.each([
    ["flipped ciphertext", (s: string) => s.slice(0, 12) + (s[12] === "A" ? "B" : "A") + s.slice(13)],
    ["truncated value", (s: string) => s.slice(0, -6)],
    ["corrupted tag", (s: string) => {
      const i = s.lastIndexOf(".") + 1;
      return s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
    }],
    ["wrong version prefix", (s: string) => `v2.${s.split(".").slice(1).join(".")}`],
    ["not our format", () => "plain-cookie-value"],
    ["", () => ""],
  ])("rejects %s with null instead of throwing", (_label, mutate) => {
    const sealed = seal({ sub: "auth0|abc" }, SECRET);
    expect(unseal(mutate(sealed), SECRET)).toBeNull();
  });

  it("rejects values sealed with another secret", () => {
    const sealed = seal({ sub: "auth0|abc" }, SECRET);
    expect(unseal(sealed, OTHER_SECRET)).toBeNull();
  });
});

describe("buildSessionPayload", () => {
  it("mints an allow-listed payload with sid/iat/exp defaults", () => {
    const payload = buildSessionPayload({ sub: "auth0|abc", email: "a@x.com", name: "A", nowSeconds: 1_000 });
    expect(payload).toMatchObject({ sub: "auth0|abc", email: "a@x.com", name: "A", iat: 1_000 });
    expect(payload.exp).toBeGreaterThan(payload.iat);
    expect(typeof payload.sid).toBe("string");
    expect(Object.keys(payload).sort()).toEqual(["email", "exp", "iat", "name", "sid", "sub"]);
  });

  it("omits empty profile fields and honours explicit sid/ttl", () => {
    const payload = buildSessionPayload({
      sub: "auth0|abc",
      email: "",
      name: undefined,
      sid: "fixed-sid",
      nowSeconds: 500,
      ttlSeconds: 60,
    });
    expect(payload).toEqual({ sub: "auth0|abc", sid: "fixed-sid", iat: 500, exp: 560 });
  });

  it("refuses to mint a session without a subject", () => {
    expect(() => buildSessionPayload({ sub: "" })).toThrow(/without an Auth0 subject/);
  });

  it("ignores non-string profile values instead of sealing them", () => {
    const payload = buildSessionPayload({ sub: "auth0|abc", email: 42, name: { x: 1 } });
    expect("email" in payload).toBe(false);
    expect("name" in payload).toBe(false);
  });
  it("carries uid/wid from provisioning through seal and read", () => {
    const payload = buildSessionPayload({ sub: "auth0|abc", uid: "user-1", wid: "ws-1", nowSeconds: 1_000 });
    expect(payload.uid).toBe("user-1");
    expect(payload.wid).toBe("ws-1");
    const sealed = seal(payload, SECRET);
    expect(readSession(sealed, SECRET, 1_500)).toMatchObject({ uid: "user-1", wid: "ws-1" });
  });

  it("drops non-string uid/wid instead of sealing them", () => {
    const payload = buildSessionPayload({ sub: "auth0|abc", uid: 42, wid: null });
    expect("uid" in payload).toBe(false);
    expect("wid" in payload).toBe(false);
  });
});

describe("token-material guard", () => {
  it("passes a genuine session cookie", () => {
    const sealed = seal(buildSessionPayload({ sub: "auth0|abc" }), SECRET);
    expect(() => {
      assertNoTokenMaterial(sealed, SECRET);
    }).not.toThrow();
  });

  it.each(["access_token", "refresh_token", "id_token", "token_type"])(
    "throws when the sealed payload contains %s",
    (field) => {
      const sealed = seal({ sub: "auth0|abc", [field]: "leaked" }, SECRET);
      expect(() => {
        assertNoTokenMaterial(sealed, SECRET);
      }).toThrow(new RegExp(`never contain ${field}`));
    },
  );

  it("throws on a non-object payload", () => {
    const sealed = seal([1, 2, 3], SECRET);
    expect(() => {
      assertNoTokenMaterial(sealed, SECRET);
    }).toThrow(/not a sealed JSON object/);
  });
});

describe("readSession", () => {
  const live = (now: number) => seal(buildSessionPayload({ sub: "auth0|abc", nowSeconds: now }), SECRET);

  it("returns the payload for a live session", () => {
    expect(readSession(live(1_000), SECRET, 1_500)?.sub).toBe("auth0|abc");
  });

  it.each([
    ["missing cookie", () => undefined, 1_500],
    ["empty cookie", () => "", 1_500],
    ["tampered cookie", () => "v1.bad.bad.bad", 1_500],
    ["expired session", () => live(1_000), 1_000 + 12 * 60 * 60 + 1],
  ])("returns null for %s", (_label, get, now) => {
    expect(readSession(get(), SECRET, now)).toBeNull();
  });

  it("returns null for a well-formed but wrongly-shaped payload", () => {
    expect(readSession(seal({ nope: true }, SECRET), SECRET, 1_500)).toBeNull();
  });

  it("honours exact expiry boundaries", () => {
    const payload = buildSessionPayload({ sub: "auth0|abc", nowSeconds: 1_000, ttlSeconds: 60 });
    const sealed = seal(payload, SECRET);
    expect(readSession(sealed, SECRET, 1_059)?.sub).toBe("auth0|abc");
    expect(readSession(sealed, SECRET, 1_060)).toBeNull();
  });
});

describe("readOAuthState", () => {
  it("round-trips a live state", () => {
    const sealed = seal({ state: "s", verifier: "v", exp: 2_000 }, SECRET);
    expect(readOAuthState(sealed, SECRET, 1_000)).toEqual({ state: "s", verifier: "v", exp: 2_000 });
  });

  it("returns null when expired, tampered or wrongly shaped", () => {
    const sealed = seal({ state: "s", verifier: "v", exp: 2_000 }, SECRET);
    expect(readOAuthState(sealed, SECRET, 2_001)).toBeNull();
    expect(readOAuthState("v1.x.y.z", SECRET, 1_000)).toBeNull();
    expect(readOAuthState(seal({ state: "s" }, SECRET), SECRET, 1_000)).toBeNull();
    expect(readOAuthState(undefined, SECRET, 1_000)).toBeNull();
  });
});

describe("cookie flags", () => {
  it("marks the session cookie Secure + HttpOnly + host-only + Lax, never Domain", () => {
    const header = sessionSetCookie("sealed-value");
    expect(header.startsWith(`${SESSION_COOKIE}=sealed-value; `)).toBe(true);
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    for (const flag of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age="]) {
      expect(header).toContain(flag);
    }
    expect(header).not.toMatch(/Domain=/i);
  });

  it("clears the session with identical flags and immediate expiry", () => {
    const header = sessionClearCookie();
    expect(header.startsWith(`${SESSION_COOKIE}=; `)).toBe(true);
    expect(header).toContain("Max-Age=0");
    for (const flag of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) {
      expect(header).toContain(flag);
    }
    expect(header).not.toMatch(/Domain=/i);
  });

  it("scopes the OAuth state cookie short-lived and host-only", () => {
    expect(OAUTH_STATE_COOKIE.startsWith("__Host-")).toBe(true);
    const header = oauthStateSetCookie("state-value");
    expect(header).toContain("Max-Age=600");
    expect(header).not.toMatch(/Domain=/i);
    expect(oauthStateClearCookie()).toContain("Max-Age=0");
  });
});

describe("statesMatch", () => {
  it("compares in constant time without leaking mismatch position", () => {
    expect(statesMatch("abc", "abc")).toBe(true);
    expect(statesMatch("abc", "abd")).toBe(false);
    expect(statesMatch("abc", "abcd")).toBe(false);
    expect(statesMatch("", "")).toBe(true);
  });
});
