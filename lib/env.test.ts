import { afterEach, describe, expect, it } from "vitest";
import { getSupabaseConfig, hasSupabase } from "./env";

const URL_KEY = "NEXT_PUBLIC_SUPABASE_URL";
const ANON_KEY = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";

const savedUrl = process.env[URL_KEY];
const savedKey = process.env[ANON_KEY];

afterEach(() => {
  if (savedUrl === undefined) delete process.env[URL_KEY];
  else process.env[URL_KEY] = savedUrl;
  if (savedKey === undefined) delete process.env[ANON_KEY];
  else process.env[ANON_KEY] = savedKey;
});

function setEnv(url: string | undefined, key: string | undefined) {
  if (url === undefined) delete process.env[URL_KEY];
  else process.env[URL_KEY] = url;
  if (key === undefined) delete process.env[ANON_KEY];
  else process.env[ANON_KEY] = key;
}

describe("supabase public configuration", () => {
  it("reports missing when both values are absent", () => {
    setEnv(undefined, undefined);
    expect(getSupabaseConfig().status).toBe("missing");
    expect(hasSupabase()).toBe(false);
  });

  it("treats blank values as missing", () => {
    setEnv("   ", "  ");
    expect(getSupabaseConfig().status).toBe("missing");
    expect(hasSupabase()).toBe(false);
  });

  it("reports partial when only one value is present", () => {
    setEnv("https://example.supabase.co", undefined);
    const urlOnly = getSupabaseConfig();
    expect(urlOnly.status).toBe("partial");
    expect(urlOnly.detail).toMatch("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    expect(hasSupabase()).toBe(false);

    setEnv(undefined, "test-publishable-key");
    const keyOnly = getSupabaseConfig();
    expect(keyOnly.status).toBe("partial");
    expect(keyOnly.detail).toMatch("NEXT_PUBLIC_SUPABASE_URL");
  });

  it("reports invalid for a malformed URL", () => {
    setEnv("not-a-url", "test-publishable-key");
    const config = getSupabaseConfig();
    expect(config.status).toBe("invalid");
    expect(config.detail).toMatch("NEXT_PUBLIC_SUPABASE_URL");
    expect(hasSupabase()).toBe(false);
  });

  it("reports configured for a valid URL and key", () => {
    setEnv("https://example.supabase.co", "test-publishable-key");
    expect(getSupabaseConfig().status).toBe("configured");
    expect(hasSupabase()).toBe(true);
  });
});
