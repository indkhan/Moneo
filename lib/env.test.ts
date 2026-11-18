import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appPort, appUrl, bankTokenKey, desktopBridgeUrl, enableBankingApiUrl, getSupabaseConfig, hasBankTokenKey, hasServiceRoleKey,
  hasSupabase, isDesktopPreview, isDesktopRuntime, loopbackUrl, ownerCredentials, scalableMcpOrigin, serviceKeyFromEnv, serviceRoleConfig, supabaseClientConfig,
} from "./env";

const URL_KEY = "NEXT_PUBLIC_SUPABASE_URL";
const ANON_KEY = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";

afterEach(() => vi.unstubAllEnvs());

function setEnv(url: string | undefined, key: string | undefined) {
  vi.stubEnv(URL_KEY, url);
  vi.stubEnv(ANON_KEY, key);
}

function failureOf(read: () => unknown) {
  try { read(); } catch (error) { return error as Error; }
  return null;
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

  it.each(["https:example.supabase.co", "https:/example.supabase.co"])(
    "reports invalid when the scheme delimiter is missing in %s",
    (url) => {
      setEnv(url, "test-publishable-key");
      const config = getSupabaseConfig();
      expect(config.status).toBe("invalid");
      expect(config.detail).toMatch("NEXT_PUBLIC_SUPABASE_URL");
      expect(hasSupabase()).toBe(false);
    },
  );

  it("accepts an uppercase http(s) scheme like the Supabase SDK", () => {
    setEnv("HTTPS://example.supabase.co", "test-publishable-key");
    expect(getSupabaseConfig().status).toBe("configured");
    expect(hasSupabase()).toBe(true);
  });

  it("reports configured for a valid URL and key", () => {
    setEnv("https://example.supabase.co", "test-publishable-key");
    expect(getSupabaseConfig().status).toBe("configured");
    expect(hasSupabase()).toBe(true);
    expect(supabaseClientConfig()).toEqual({ url: "https://example.supabase.co", key: "test-publishable-key" });
  });

  it("refuses to hand out a client configuration that is incomplete", () => {
    setEnv("https://example.supabase.co", undefined);
    expect(() => supabaseClientConfig()).toThrow("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  });
});

describe("service role configuration", () => {
  it("is absent until both the address and the key are set", () => {
    vi.stubEnv(URL_KEY, "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    expect(serviceRoleConfig()).toBeNull();
    expect(hasServiceRoleKey()).toBe(false);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "  service-key  ");
    expect(serviceRoleConfig()).toEqual({ url: "https://example.supabase.co", key: "service-key" });
    expect(hasServiceRoleKey()).toBe(true);
  });
});

describe("address and port", () => {
  it("falls back to the default port and a localhost address", () => {
    vi.stubEnv("PORT", undefined);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
    expect(appPort()).toBe(3000);
    expect(loopbackUrl()).toBe("http://127.0.0.1:3000");
    expect(appUrl()).toBe("http://localhost:3000");
  });

  it("follows PORT and an explicit app address", () => {
    vi.stubEnv("PORT", "47300");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://moneo.example.ts.net");
    expect(loopbackUrl()).toBe("http://127.0.0.1:47300");
    expect(appUrl()).toBe("https://moneo.example.ts.net");
  });

  it.each(["abc", "0", "70000", "80.5"])("rejects PORT=%s and names the variable", value => {
    vi.stubEnv("PORT", value);
    expect(() => appPort()).toThrow(/^PORT is invalid/);
  });

  it("rejects a malformed app address without printing it", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "garbage-value");
    const failure = failureOf(appUrl);
    expect(failure?.message).toMatch(/^NEXT_PUBLIC_APP_URL is invalid/);
    expect(failure?.message).not.toContain("garbage-value");
  });
});

describe("bank token key", () => {
  const valid = Buffer.alloc(32, 7).toString("base64");

  it("is optional until something needs to seal a token", () => {
    vi.stubEnv("BANK_TOKEN_ENCRYPTION_KEY", undefined);
    expect(hasBankTokenKey()).toBe(false);
    expect(() => bankTokenKey()).toThrow(/^BANK_TOKEN_ENCRYPTION_KEY is invalid/);
  });

  it("decodes a 32 byte base64 key", () => {
    vi.stubEnv("BANK_TOKEN_ENCRYPTION_KEY", valid);
    expect(hasBankTokenKey()).toBe(true);
    expect(bankTokenKey()).toEqual(Buffer.alloc(32, 7));
  });

  it("rejects a key of the wrong length without printing it", () => {
    const short = Buffer.alloc(16, 9).toString("base64");
    vi.stubEnv("BANK_TOKEN_ENCRYPTION_KEY", short);
    const failure = failureOf(bankTokenKey);
    expect(failure?.message).toMatch(/^BANK_TOKEN_ENCRYPTION_KEY is invalid/);
    expect(failure?.message).not.toContain(short);
  });
});

describe("optional integrations", () => {
  it("default to the real services when unset and reject a malformed address", () => {
    vi.stubEnv("ENABLE_BANKING_API_URL", undefined);
    vi.stubEnv("SCALABLE_MCP_ORIGIN", "");
    expect(enableBankingApiUrl()).toBe("https://api.enablebanking.com");
    expect(scalableMcpOrigin()).toBe("https://mcp.scalable.capital");
    vi.stubEnv("ENABLE_BANKING_API_URL", "http://127.0.0.1:4010");
    expect(enableBankingApiUrl()).toBe("http://127.0.0.1:4010");
    vi.stubEnv("SCALABLE_MCP_ORIGIN", "nope");
    expect(() => scalableMcpOrigin()).toThrow(/^SCALABLE_MCP_ORIGIN is invalid/);
  });

  it("read AI and bank keys as trimmed values, or nothing", () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(serviceKeyFromEnv("OPENAI_API_KEY")).toBeUndefined();
    vi.stubEnv("OPENAI_API_KEY", "  sk-test  ");
    expect(serviceKeyFromEnv("OPENAI_API_KEY")).toBe("sk-test");
  });

  it("sign the owner in only when both credentials are set", () => {
    vi.stubEnv("MONEO_OWNER_EMAIL", "owner@example.test");
    vi.stubEnv("MONEO_OWNER_PASSWORD", undefined);
    expect(ownerCredentials()).toBeNull();
    vi.stubEnv("MONEO_OWNER_PASSWORD", "pw");
    expect(ownerCredentials()).toEqual({ email: "owner@example.test", password: "pw" });
  });
});

describe("desktop runtime settings", () => {
  it("are inert outside the desktop app even when the bridge is set", () => {
    vi.stubEnv("MONEO_DESKTOP", undefined);
    vi.stubEnv("MONEO_DESKTOP_BRIDGE", "http://127.0.0.1:47301");
    vi.stubEnv("MONEO_DESKTOP_PREVIEW", "1");
    expect(isDesktopRuntime()).toBe(false);
    expect(isDesktopPreview()).toBe(false);
    expect(desktopBridgeUrl()).toBeUndefined();
  });

  it("read the bridge and preview flag at runtime inside the desktop app", () => {
    vi.stubEnv("MONEO_DESKTOP", "1");
    vi.stubEnv("MONEO_DESKTOP_BRIDGE", "http://127.0.0.1:47301");
    vi.stubEnv("MONEO_DESKTOP_PREVIEW", "1");
    expect(isDesktopRuntime()).toBe(true);
    expect(isDesktopPreview()).toBe(true);
    expect(desktopBridgeUrl()).toBe("http://127.0.0.1:47301");
  });

  it("name a malformed bridge address", () => {
    vi.stubEnv("MONEO_DESKTOP", "1");
    vi.stubEnv("MONEO_DESKTOP_BRIDGE", "not a url");
    expect(() => desktopBridgeUrl()).toThrow(/^MONEO_DESKTOP_BRIDGE is invalid/);
  });
});
