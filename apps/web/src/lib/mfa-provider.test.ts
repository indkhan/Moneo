import { describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "./auth-config";
import {
  Auth0MfaProvider,
  ManagementTokenCache,
  MfaProviderError,
  managementCredentials,
  passkeysEnabled,
} from "./mfa-provider";

const CONFIG: AuthConfig = {
  issuer: "https://moneo.eu.auth0.com",
  loginHost: "https://moneo.eu.auth0.com",
  clientId: "client-123",
  clientSecret: "secret-abc",
  baseUrl: "http://localhost:3000",
};

const CREDENTIALS = { clientId: "client-123", clientSecret: "secret-abc" };

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe("passkeysEnabled", () => {
  it("offers passkeys unless explicitly opted out", () => {
    expect(passkeysEnabled(undefined)).toBe(true);
    expect(passkeysEnabled("true")).toBe(true);
    expect(passkeysEnabled("false")).toBe(false);
    expect(passkeysEnabled("0")).toBe(false);
    expect(passkeysEnabled("no")).toBe(false);
    expect(passkeysEnabled(" False ")).toBe(false);
  });
});

describe("managementCredentials", () => {
  it("prefers the dedicated pair and falls back to the base pair", () => {
    expect(
      managementCredentials({
        ...CREDENTIALS,
        managementClientId: "m2m",
        managementClientSecret: "m2m-secret",
      }),
    ).toEqual({ clientId: "m2m", clientSecret: "m2m-secret" });
    expect(managementCredentials(CREDENTIALS)).toEqual(CREDENTIALS);
  });

  it("refuses empty credentials instead of calling the provider", () => {
    expect(() => managementCredentials({ clientId: "", clientSecret: "" })).toThrow(
      MfaProviderError,
    );
  });
});

describe("ManagementTokenCache", () => {
  function tokenGrant(fetchImpl: ReturnType<typeof vi.fn>, expiresIn = 3600) {
    return fetchImpl.mockResolvedValue(
      jsonResponse(200, { access_token: "mgmt-token", expires_in: expiresIn }),
    );
  }

  it("fetches a client-credentials token against the EU issuer audience", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { access_token: "t", expires_in: 60 })),
    );
    const cache = new ManagementTokenCache(CONFIG, CREDENTIALS, fetchImpl);
    await expect(cache.tokenFor(1_000)).resolves.toBe("t");
    expect(fetchImpl).toHaveBeenCalledWith("https://moneo.eu.auth0.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: "client-123",
        client_secret: "secret-abc",
        audience: "https://moneo.eu.auth0.com/api/v2/",
      }),
    });
  });

  it("reuses the token until near expiry, then refreshes", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { access_token: "t", expires_in: 100 })),
    );
    tokenGrant(fetchImpl, 100);
    const cache = new ManagementTokenCache(CONFIG, CREDENTIALS, fetchImpl);
    await cache.tokenFor(1_000);
    await cache.tokenFor(1_050);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await cache.tokenFor(1_071);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps network, rejection and empty-token failures to UNAVAILABLE/UNAUTHORIZED", async () => {
    const down = new ManagementTokenCache(CONFIG, CREDENTIALS, () =>
      Promise.reject(new Error("down")),
    );
    await expect(down.tokenFor()).rejects.toMatchObject({
      name: "MfaProviderError",
      code: "UNAVAILABLE",
    });

    const denied = new ManagementTokenCache(
      CONFIG,
      CREDENTIALS,
      vi.fn(() => Promise.resolve(jsonResponse(401, {}))),
    );
    await expect(denied.tokenFor()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const empty = new ManagementTokenCache(
      CONFIG,
      CREDENTIALS,
      vi.fn(() => Promise.resolve(jsonResponse(200, { access_token: "" }))),
    );
    await expect(empty.tokenFor()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("Auth0MfaProvider.listFactors", () => {
  function providerWithFactors(factors: unknown, status = 200) {
    const fetchImpl = vi.fn((url: string) => {
      if (url.endsWith("/oauth/token")) {
        return Promise.resolve(jsonResponse(200, { access_token: "mgmt", expires_in: 300 }));
      }
      return Promise.resolve(jsonResponse(status, factors));
    });
    const tokens = new ManagementTokenCache(CONFIG, CREDENTIALS, fetchImpl);
    return { provider: new Auth0MfaProvider(CONFIG, tokens, fetchImpl, true), fetchImpl };
  }

  it("maps passkey and fallback factor types, marking unconfirmed", async () => {
    const { provider, fetchImpl } = providerWithFactors([
      { id: "p1", type: "webauthn-platform", confirmed: true },
      { id: "p2", type: "webauthn-roaming" },
      { id: "t1", type: "totp", confirmed: true },
      { id: "r1", type: "recovery-code", confirmed: true },
      { id: "x1", type: "future-factor", confirmed: true },
    ]);
    const factors = await provider.listFactors("auth0|abc");
    expect(factors).toEqual([
      { id: "p1", kind: "passkey", providerType: "webauthn-platform", confirmed: true },
      { id: "p2", kind: "passkey", providerType: "webauthn-roaming", confirmed: true },
      { id: "t1", kind: "totp", providerType: "totp", confirmed: true },
      { id: "r1", kind: "recovery-code", providerType: "recovery-code", confirmed: true },
      { id: "x1", kind: "other", providerType: "future-factor", confirmed: true },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://moneo.eu.auth0.com/api/v2/users/auth0%7Cabc/authentication-methods",
      { headers: { authorization: "Bearer mgmt" } },
    );
  });

  it("skips non-object entries and maps 401/404/500 precisely", async () => {
    const { provider } = providerWithFactors(["junk", null, 42]);
    expect(await provider.listFactors("auth0|abc")).toEqual([]);

    const denied = providerWithFactors([], 401).provider;
    await expect(denied.listFactors("auth0|abc")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const missing = providerWithFactors([], 404).provider;
    await expect(missing.listFactors("auth0|abc")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const broken = providerWithFactors([], 500).provider;
    await expect(broken.listFactors("auth0|abc")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rejects empty user ids without calling the provider", async () => {
    const { provider, fetchImpl } = providerWithFactors([]);
    await expect(provider.listFactors("")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Auth0MfaProvider.enrollmentTicket", () => {
  it("mints a provider-hosted ticket for the subject", async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.endsWith("/oauth/token")) {
        return Promise.resolve(jsonResponse(200, { access_token: "mgmt", expires_in: 300 }));
      }
      return Promise.resolve(
        jsonResponse(200, { ticket_url: "https://moneo.eu.auth0.com/enroll/abc" }),
      );
    });
    const tokens = new ManagementTokenCache(CONFIG, CREDENTIALS, fetchImpl);
    const provider = new Auth0MfaProvider(CONFIG, tokens, fetchImpl, true);
    await expect(provider.enrollmentTicket("auth0|abc")).resolves.toEqual({
      ticketUrl: "https://moneo.eu.auth0.com/enroll/abc",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://moneo.eu.auth0.com/api/v2/guardian/enrollments/ticket",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fails closed on missing URLs, rejections and empty subjects", async () => {
    const noUrl = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith("/oauth/token")
          ? jsonResponse(200, { access_token: "mgmt", expires_in: 300 })
          : jsonResponse(200, { ticket_url: "" }),
      ),
    );
    const provider = new Auth0MfaProvider(
      CONFIG,
      new ManagementTokenCache(CONFIG, CREDENTIALS, noUrl),
      noUrl,
      true,
    );
    await expect(provider.enrollmentTicket("auth0|abc")).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await expect(provider.enrollmentTicket("")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
