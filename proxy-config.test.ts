import { afterEach, expect, it, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));

const URL_KEY = "NEXT_PUBLIC_SUPABASE_URL";
const ANON_KEY = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";
const savedUrl = process.env[URL_KEY];
const savedKey = process.env[ANON_KEY];

afterEach(() => {
  vi.clearAllMocks();
  if (savedUrl === undefined) delete process.env[URL_KEY];
  else process.env[URL_KEY] = savedUrl;
  if (savedKey === undefined) delete process.env[ANON_KEY];
  else process.env[ANON_KEY] = savedKey;
});

it("passes unconfigured requests through without constructing an auth client", async () => {
  delete process.env[URL_KEY];
  delete process.env[ANON_KEY];
  const request = new NextRequest("http://localhost:3000/");
  const response = await proxy(request);
  expect(vi.mocked(createServerClient)).not.toHaveBeenCalled();
  expect(response.status).toBe(200);
});

it("passes partially configured requests through without constructing an auth client", async () => {
  process.env[URL_KEY] = "https://example.supabase.co";
  delete process.env[ANON_KEY];
  const request = new NextRequest("http://localhost:3000/");
  await proxy(request);
  expect(vi.mocked(createServerClient)).not.toHaveBeenCalled();
});

it("refreshes sessions when configuration is present", async () => {
  process.env[URL_KEY] = "https://example.supabase.co";
  process.env[ANON_KEY] = "test-publishable-key";
  const getClaims = vi.fn(async () => ({ data: null, error: null }));
  vi.mocked(createServerClient).mockReturnValue({ auth: { getClaims } } as unknown as ReturnType<typeof createServerClient>);
  const request = new NextRequest("http://localhost:3000/plan");
  await proxy(request);
  expect(vi.mocked(createServerClient)).toHaveBeenCalledOnce();
  expect(getClaims).toHaveBeenCalledOnce();
});
