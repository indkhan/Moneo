import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { CSRF_COOKIE } from "./lib/csrf";
import { config, middleware } from "./middleware";

vi.mock("./lib/auth0", () => ({
  auth0: { middleware: async () => await Promise.resolve(NextResponse.next()) },
}));

const BASE = "http://localhost:3000";
const get = (path: string) => new NextRequest(`${BASE}${path}`, { method: "GET" });
function post(path: string, csrfToken?: string, origin?: string): NextRequest {
  const headers = new Headers();
  if (csrfToken) headers.set("x-csrf-token", csrfToken);
  if (origin) headers.set("origin", origin);
  const request = new NextRequest(`${BASE}${path}`, { method: "POST", headers });
  if (csrfToken) request.cookies.set(CSRF_COOKIE, csrfToken);
  return request;
}

describe("middleware", () => {
  it("adds hardening and CSRF cookies to safe requests", async () => {
    const response = await middleware(get("/home"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(response.headers.getSetCookie()[0]).toContain(`${CSRF_COOKIE}=`);
  });

  it("rejects unsafe API requests without a valid same-origin CSRF pair", async () => {
    expect((await middleware(post("/api/v1/health"))).status).toBe(403);
    expect((await middleware(post("/api/v1/health", "token", "https://evil.com"))).status).toBe(403);
    expect((await middleware(post("/api/v1/health", "token", BASE))).status).not.toBe(403);
  });

  it("does not require CSRF for safe routes", async () => {
    expect((await middleware(get("/api/v1/health"))).status).toBe(200);
  });

  it("covers every route except framework assets", () => {
    expect(config.matcher).toEqual(["/((?!_next/static|_next/image|favicon.ico).*)"]);
  });
});
