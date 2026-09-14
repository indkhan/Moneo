import { describe, expect, it } from "vitest";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  csrfSetCookie,
  guardMutation,
  isMutationMethod,
  issueCsrfToken,
  tokensMatch,
  validateCsrfToken,
  validateFetchMetadata,
  validateOrigin,
} from "./csrf";

const APP_ORIGIN = "http://localhost:3000";

function mutation(overrides: Partial<Parameters<typeof guardMutation>[0]> = {}) {
  const token = issueCsrfToken();
  return guardMutation({
    method: "POST",
    cookieToken: token,
    headerToken: token,
    origin: APP_ORIGIN,
    referer: null,
    secFetchSite: "same-origin",
    appOrigin: APP_ORIGIN,
    ...overrides,
  });
}

describe("isMutationMethod", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "post"])("treats %s as a mutation", (method) => {
    expect(isMutationMethod(method)).toBe(true);
  });

  it.each(["GET", "HEAD", "OPTIONS", "get"])("never guards %s", (method) => {
    expect(isMutationMethod(method)).toBe(false);
  });
});

describe("issueCsrfToken", () => {
  it("issues 32-byte base64url tokens, unique per call", () => {
    const token = issueCsrfToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issueCsrfToken()).not.toBe(token);
  });
});

describe("tokensMatch", () => {
  it("compares equal tokens true and anything else false", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(tokensMatch("", "")).toBe(false);
    expect(tokensMatch("", "a")).toBe(false);
  });
});

describe("validateCsrfToken", () => {
  it("accepts a matching pair", () => {
    const token = issueCsrfToken();
    expect(validateCsrfToken(token, token)).toBeNull();
  });

  it.each([
    ["missing cookie", undefined, "header", "missing_cookie"],
    ["missing header", "cookie", null, "missing_header"],
    ["both missing", undefined, null, "missing_cookie"],
    ["mismatch", "cookie-a", "cookie-b", "mismatch"],
  ])("reports %s", (_label, cookie, header, expected) => {
    expect(validateCsrfToken(cookie, header)).toBe(expected);
  });
});

describe("validateOrigin", () => {
  it("accepts the app origin via Origin or Referer", () => {
    expect(validateOrigin(APP_ORIGIN, null, APP_ORIGIN)).toBe("ok");
    expect(validateOrigin(null, `${APP_ORIGIN}/api/x`, APP_ORIGIN)).toBe("ok");
  });

  it("is case-insensitive on the origin triple", () => {
    expect(validateOrigin("HTTP://LOCALHOST:3000", null, APP_ORIGIN)).toBe("ok");
  });

  it("rejects cross-origin, malformed and trailing-dot origins", () => {
    expect(validateOrigin("https://evil.com", null, APP_ORIGIN)).toBe("mismatch");
    expect(validateOrigin("http://localhost:3000.evil.com", null, APP_ORIGIN)).toBe("mismatch");
    expect(validateOrigin("not a url", null, APP_ORIGIN)).toBe("mismatch");
    expect(validateOrigin(null, "https://evil.com/path", APP_ORIGIN)).toBe("mismatch");
  });

  it("reports absent when neither header exists", () => {
    expect(validateOrigin(null, null, APP_ORIGIN)).toBe("absent");
  });
});

describe("validateFetchMetadata", () => {
  it("rejects cross-site mutations only", () => {
    expect(validateFetchMetadata("cross-site")).toBe("cross_site");
    expect(validateFetchMetadata("same-origin")).toBe("ok");
    expect(validateFetchMetadata("same-site")).toBe("ok");
    expect(validateFetchMetadata("none")).toBe("ok");
    expect(validateFetchMetadata(null)).toBe("absent");
  });
});

describe("guardMutation", () => {
  it("allows a well-formed same-origin write", () => {
    expect(mutation()).toEqual({ allowed: true });
  });

  it("rejects a missing CSRF pair", () => {
    expect(
      mutation({ cookieToken: undefined, headerToken: null, origin: null, secFetchSite: null }),
    ).toEqual({
      allowed: false,
      reason: "csrf_missing_cookie",
    });
    const token = issueCsrfToken();
    expect(
      mutation({ cookieToken: token, headerToken: null, origin: null, secFetchSite: null }),
    ).toEqual({
      allowed: false,
      reason: "csrf_missing_header",
    });
  });

  it("rejects an invalid Origin write even with a valid CSRF pair", () => {
    const token = issueCsrfToken();
    expect(
      mutation({ cookieToken: token, headerToken: token, origin: "https://evil.com" }),
    ).toEqual({
      allowed: false,
      reason: "origin_mismatch",
    });
  });

  it("rejects cross-site Fetch Metadata even with a valid CSRF pair", () => {
    const token = issueCsrfToken();
    expect(
      mutation({
        cookieToken: token,
        headerToken: token,
        origin: null,
        secFetchSite: "cross-site",
      }),
    ).toEqual({ allowed: false, reason: "fetch_metadata_cross_site" });
  });

  it("allows non-browser clients carrying the token but no metadata headers", () => {
    const token = issueCsrfToken();
    expect(
      mutation({
        cookieToken: token,
        headerToken: token,
        origin: null,
        referer: null,
        secFetchSite: null,
      }),
    ).toEqual({ allowed: true });
  });

  it("checks CSRF before Origin so failures name the missing token", () => {
    expect(mutation({ headerToken: "wrong", origin: "https://evil.com" })).toEqual({
      allowed: false,
      reason: "csrf_mismatch",
    });
  });
});

describe("csrfSetCookie", () => {
  it("is host-only, Secure and Lax — readable by our JS by double-submit design", () => {
    const header = csrfSetCookie("token-123");
    expect(header).toContain(`${CSRF_COOKIE}=token-123`);
    expect(header).toContain("Path=/");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Max-Age=");
    expect(header).not.toMatch(/Domain=/i);
    expect(header).not.toMatch(/HttpOnly/i);
    expect(CSRF_COOKIE.startsWith("__Host-")).toBe(true);
    expect(CSRF_HEADER).toBe("x-csrf-token");
  });
});
