import { afterEach, expect, it, vi } from "vitest";
import { GET } from "./route";

const URL_KEY = "NEXT_PUBLIC_SUPABASE_URL";
const ANON_KEY = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";
const savedUrl = process.env[URL_KEY];
const savedKey = process.env[ANON_KEY];

afterEach(() => {
  if (savedUrl === undefined) delete process.env[URL_KEY];
  else process.env[URL_KEY] = savedUrl;
  if (savedKey === undefined) delete process.env[ANON_KEY];
  else process.env[ANON_KEY] = savedKey;
  vi.unstubAllEnvs();
});

it("reports unconfigured without throwing when both values are absent", async () => {
  vi.stubEnv(URL_KEY, "");
  vi.stubEnv(ANON_KEY, "");
  const response = await GET();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.supabase).toBe(false);
  expect(body.supabaseStatus).toBe("missing");
  expect(typeof body.detail).toBe("string");
});

it("reports a precise partial state when only one value is present", async () => {
  vi.stubEnv(URL_KEY, "https://example.supabase.co");
  vi.stubEnv(ANON_KEY, "");
  const body = await (await GET()).json();
  expect(body.supabase).toBe(false);
  expect(body.supabaseStatus).toBe("partial");
  expect(body.detail).toMatch("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
});

it("reports invalid for a malformed URL", async () => {
  vi.stubEnv(URL_KEY, "not-a-url");
  vi.stubEnv(ANON_KEY, "test-publishable-key");
  const body = await (await GET()).json();
  expect(body.supabase).toBe(false);
  expect(body.supabaseStatus).toBe("invalid");
  expect(body.detail).toMatch("NEXT_PUBLIC_SUPABASE_URL");
});
