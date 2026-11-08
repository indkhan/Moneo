import { beforeEach, expect, it, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { proxy, config } from "./proxy";

vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
});

it("lets internal Workflow requests reach the executor without session proxying", () => {
  for (const url of ["/.well-known/workflow/v1/flow", "/.well-known/workflow/v1/step", "/.well-known/workflow/v1/webhook/token"])
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
  expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/plan" })).toBe(true);
});

it("forwards refreshed cookies to rendering and the browser without caching session responses", async () => {
  const request = new NextRequest("http://localhost:3000/plan", { headers: { cookie: "session=expired" } });
  const getClaims = vi.fn(async () => {
    const adapter = vi.mocked(createServerClient).mock.calls[0][2].cookies!;
    expect(adapter.getAll!()).toEqual([{ name: "session", value: "expired" }]);
    adapter.setAll!([{ name: "session", value: "fresh", options: { httpOnly: true, path: "/" } }], { "Cache-Control": "private, no-store" });
    return { data: { claims: { sub: "user" } }, error: null };
  });
  vi.mocked(createServerClient).mockReturnValue({ auth: { getClaims } } as unknown as ReturnType<typeof createServerClient>);
  const response = await proxy(request);
  expect(getClaims).toHaveBeenCalledOnce();
  expect(request.cookies.get("session")?.value).toBe("fresh");
  expect(response.headers.get("x-middleware-request-cookie")).toBe("session=fresh");
  expect(response.cookies.get("session")).toMatchObject({ value: "fresh", httpOnly: true });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

function withClaims(result: { data: unknown; error: unknown }) {
  const signInWithPassword = vi.fn(async () => ({ data: {}, error: null }));
  vi.mocked(createServerClient).mockReturnValue({ auth: { getClaims: vi.fn(async () => result), signInWithPassword } } as unknown as ReturnType<typeof createServerClient>);
  return signInWithPassword;
}

it("signs the owner in from .env when there is no session, without redirecting", async () => {
  process.env.MONEO_OWNER_EMAIL = "owner@moneo.local";
  process.env.MONEO_OWNER_PASSWORD = "secret";
  const signIn = withClaims({ data: null, error: null });
  const response = await proxy(new NextRequest("http://localhost:3000/money/accounts"));
  expect(signIn).toHaveBeenCalledWith({ email: "owner@moneo.local", password: "secret" });
  expect(response.headers.get("location")).toBeNull();
});

it("leaves bearer-authorized scheduled jobs alone", async () => {
  withClaims({ data: null, error: null });
  await proxy(new NextRequest("http://localhost:3000/api/cron/summaries", { headers: { authorization: "Bearer secret" } }));
  expect(createServerClient).not.toHaveBeenCalled();
});

it("keeps an existing session without signing in again", async () => {
  const signIn = withClaims({ data: { claims: { sub: "owner" } }, error: null });
  await proxy(new NextRequest("http://localhost:3000/plan"));
  expect(signIn).not.toHaveBeenCalled();
});

it("does not sign anyone out during an auth outage", async () => {
  const { AuthRetryableFetchError } = await import("@supabase/supabase-js");
  process.env.MONEO_OWNER_EMAIL = "owner@moneo.local";
  process.env.MONEO_OWNER_PASSWORD = "secret";
  const signIn = withClaims({ data: null, error: new AuthRetryableFetchError("down", 503) });
  expect((await proxy(new NextRequest("http://localhost:3000/plan"))).headers.get("location")).toBeNull();
  expect(signIn).not.toHaveBeenCalled();
});

it("refuses public Funnel traffic before the owner's automatic sign-in", async () => {
  const response = await proxy(new NextRequest("https://pc.example.ts.net/plan", { headers: { "tailscale-funnel-request": "?1" } }));
  expect(response.status).toBe(403);
  expect(createServerClient).not.toHaveBeenCalled();
});
