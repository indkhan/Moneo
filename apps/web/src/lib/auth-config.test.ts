import { describe, expect, it } from "vitest";
import { AuthConfigError, isEuAuth0Domain, loadAuthConfig, type AuthConfig } from "./auth-config";
import { loadEnv } from "@moneo/shared/env";

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return loadEnv({
    ...process.env,
    AUTH0_DOMAIN: "moneo.eu.auth0.com",
    AUTH0_CLIENT_ID: "client-123",
    AUTH0_CLIENT_SECRET: "secret-abc",
    APP_BASE_URL: "http://localhost:3000/",
    ...overrides,
  });
}

describe("EU tenant domain guard", () => {
  it.each([
    "moneo.eu.auth0.com",
    "login.eu.auth0.com",
    "a-b.c123.eu.auth0.com",
    "moneo.eu-2.auth0.com",
  ])("accepts EU tenant %s", (domain) => {
    expect(isEuAuth0Domain(domain)).toBe(true);
  });

  it.each([
    ["moneo.us.auth0.com", "non-EU region"],
    ["moneo.auth0.com", "regionless domain"],
    ["eu.auth0.com", "bare regional suffix"],
    ["moneo.eu.auth0.com.evil.com", "suffix smuggling"],
    ["evil.com", "unrelated host"],
    ["moneo.eu.auth0.com.", "trailing dot"],
    ["", "empty"],
    ["moneo_eu.auth0.com", "underscore label"],
    ["moneo.eu.auth0.com:443", "port suffix"],
  ])("rejects %s (%s)", (domain) => {
    expect(isEuAuth0Domain(domain)).toBe(false);
  });

  it("is case-insensitive for uppercase tenant domains", () => {
    expect(isEuAuth0Domain("MONEO.EU.AUTH0.COM")).toBe(true);
  });
});

describe("loadAuthConfig", () => {
  it("builds an SDK configuration on the canonical EU issuer by default", () => {
    const config = loadAuthConfig(baseEnv());
    expect(config.issuer).toBe("https://moneo.eu.auth0.com");
    expect(config.loginHost).toBe("https://moneo.eu.auth0.com");
  });

  it("supports a custom login domain while keeping the EU issuer canonical", () => {
    const config = loadAuthConfig(baseEnv({ AUTH0_CUSTOM_DOMAIN: "login.moneo.example" }));
    expect(config.issuer).toBe("https://moneo.eu.auth0.com");
    expect(config.loginHost).toBe("https://login.moneo.example");
  });

  it("rejects non-EU, missing and smuggled domains without leaking secrets", () => {
    for (const domain of ["moneo.us.auth0.com", "moneo.eu.auth0.com.evil.com", undefined]) {
      try {
        loadAuthConfig(baseEnv({ AUTH0_DOMAIN: domain }));
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(AuthConfigError);
        expect((error as Error).message).toContain("AUTH0_DOMAIN");
        expect((error as Error).message).not.toContain("secret-abc");
      }
    }
  });

  it("requires client id and client secret", () => {
    expect(() => loadAuthConfig(baseEnv({ AUTH0_CLIENT_ID: undefined }))).toThrow(AuthConfigError);
    expect(() => loadAuthConfig(baseEnv({ AUTH0_CLIENT_SECRET: undefined }))).toThrow(
      AuthConfigError,
    );
  });

  it("rejects a malformed custom domain", () => {
    expect(() =>
      loadAuthConfig(baseEnv({ AUTH0_CUSTOM_DOMAIN: "https://login.moneo.example/x" })),
    ).toThrow(AuthConfigError);
  });

  it("lowercases the issuer so mixed-case env cannot fork the token audience", () => {
    const config = loadAuthConfig(baseEnv({ AUTH0_DOMAIN: "MONEO.EU.AUTH0.COM" }));
    expect(config.issuer).toBe("https://moneo.eu.auth0.com");
  });
});

describe("endpoint helpers", () => {
  const config: AuthConfig = {
    issuer: "https://moneo.eu.auth0.com",
    loginHost: "https://moneo.eu.auth0.com",
    clientId: "client-123",
    clientSecret: "secret-abc",
    baseUrl: "http://localhost:3000",
  };

  it("keeps the canonical issuer on the EU tenant", () => {
    expect(config.issuer).toBe("https://moneo.eu.auth0.com");
  });
});
