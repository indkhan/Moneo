import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { CSRF_COOKIE } from "./lib/csrf";
import { config, middleware } from "./middleware";

const BASE = "http://localhost:3000";

function get(path: string, init?: { headers?: HeadersInit }): NextRequest {
  return new NextRequest(`${BASE}${path}`, { method: "GET", ...init });
}

function post(
  path: string,
  init: { csrfToken?: string; origin?: string; headers?: HeadersInit } = {},
): NextRequest {
  const { csrfToken, origin, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (csrfToken) {
    headers.set("x-csrf-token", csrfToken);
  }
  if (origin) {
    headers.set("origin", origin);
  }
  const request = new NextRequest(`${BASE}${path}`, { method: "POST", ...rest, headers });
  if (csrfToken) {
    request.cookies.set(CSRF_COOKIE, csrfToken);
  }
  return request;
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

/**
 * Issue 1.6 — middleware behaviour end to end (real NextRequest objects):
 * safe methods pass with hardening, mutations need the token, cross-origin
 * writes die with 403 JSON.
 */
describe("middleware", () => {
  it("lets GET through with hardening headers and a fresh CSRF cookie", () => {
    const response = middleware(get("/home"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    expect(response.headers.get("Strict-Transport-Security")).toBeNull();

    const cookies = setCookies(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain(`${CSRF_COOKIE}=`);
    expect(cookies[0]).toContain("Secure");
    expect(cookies[0]).not.toMatch(/Domain=/i);
  });

  it("does not re-mint the CSRF cookie when one already exists", () => {
    const request = get("/home");
    request.cookies.set(CSRF_COOKIE, "existing-token");
    expect(setCookies(middleware(request))).toHaveLength(0);
  });

  it("rejects a token-less POST with 403 JSON (missing CSRF rejected)", () => {
    const response = middleware(post("/api/v1/health"));
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("rejects an invalid Origin write even when the CSRF pair matches", async () => {
    const token = "token-for-origin-test";
    const response = middleware(post("/api/v1/health", { csrfToken: token, origin: "https://evil.com" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden", reason: "origin_mismatch" });
  });

  it("rejects cross-site Fetch Metadata on writes", async () => {
    const token = "token-for-fetch-meta";
    const response = middleware(
      post("/api/v1/health", {
        csrfToken: token,
        origin: BASE,
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: "fetch_metadata_cross_site" });
  });

  it("allows a well-formed same-origin write", () => {
    const token = "valid-token-123";
    const response = middleware(post("/api/v1/health", { csrfToken: token, origin: BASE }));
    expect(response.status).not.toBe(403);
  });

  it("never requires CSRF for safe methods, even on /api/*", () => {
    expect(middleware(get("/api/v1/health")).status).toBe(200);
    expect(middleware(get("/api/auth/login")).status).toBe(200);
  });

  it("skips the mutation gate outside /api/*", () => {
    const response = middleware(post("/money"));
    expect(response.status).not.toBe(403);
  });

  it("pins HSTS in production only", () => {
    const saved = process.env.APP_ENV;
    process.env.APP_ENV = "production";
    try {
      expect(middleware(get("/home")).headers.get("Strict-Transport-Security")).toContain("max-age=");
    } finally {
      if (saved === undefined) {
        delete process.env.APP_ENV;
      } else {
        process.env.APP_ENV = saved;
      }
    }
  });

  it("covers every route except framework assets", () => {
    expect(config.matcher).toEqual(["/((?!_next/static|_next/image|favicon.ico).*)"]);
  });
});
