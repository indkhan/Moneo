import { describe, expect, it, vi } from "vitest";
import { SessionApiError } from "./sessions-client";
import { fetchStrongAuthStatus, requestEnrollmentTicket } from "./strong-auth-client";

function stubFetch(status: number, body: unknown) {
  return vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () =>
        body === "<not-json>" ? Promise.reject(new Error("bad json")) : Promise.resolve(body),
    } as Response),
  );
}

describe("fetchStrongAuthStatus", () => {
  it("maps the status body and hits the factors endpoint", async () => {
    const fetchImpl = stubFetch(200, {
      state: "enrolled",
      method: "passkey",
      factors: [
        { id: "p1", kind: "passkey", providerType: "webauthn-platform", confirmed: true, extra: 1 },
      ],
      passkeysOffered: true,
    });
    await expect(fetchStrongAuthStatus(fetchImpl)).resolves.toEqual({
      state: "enrolled",
      method: "passkey",
      factors: [{ id: "p1", kind: "passkey", providerType: "webauthn-platform", confirmed: true }],
      passkeysOffered: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/auth/factors");
  });

  it("normalises missing methods and non-string fields", async () => {
    const fetchImpl = stubFetch(200, {
      state: "not-enrolled",
      factors: [{ id: "t1" }],
      passkeysOffered: false,
    });
    await expect(fetchStrongAuthStatus(fetchImpl)).resolves.toMatchObject({
      state: "not-enrolled",
      method: null,
      passkeysOffered: false,
    });
  });

  it("throws on errors, non-JSON and misshapen bodies", async () => {
    await expect(fetchStrongAuthStatus(stubFetch(500, {}))).rejects.toThrow(SessionApiError);
    await expect(fetchStrongAuthStatus(stubFetch(200, "<not-json>"))).rejects.toThrow(/non-JSON/);
    await expect(fetchStrongAuthStatus(stubFetch(200, { state: "enrolled" }))).rejects.toThrow(
      /unexpected shape/,
    );
    await expect(
      fetchStrongAuthStatus(
        stubFetch(200, { state: "hacked", factors: [], passkeysOffered: true }),
      ),
    ).rejects.toThrow(/unexpected shape/);
  });
});

describe("requestEnrollmentTicket", () => {
  it("POSTs the kind with CSRF and returns the provider URL", async () => {
    const fetchImpl = stubFetch(200, { ticketUrl: "https://moneo.eu.auth0.com/enroll/abc" });
    await expect(requestEnrollmentTicket(fetchImpl, "csrf-token", "passkey")).resolves.toEqual({
      ticketUrl: "https://moneo.eu.auth0.com/enroll/abc",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/auth/enrollment-ticket", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-token" },
      body: JSON.stringify({ kind: "passkey" }),
    });
  });

  it("surfaces passkey_unsupported so the UI can offer TOTP", async () => {
    const fetchImpl = stubFetch(400, { error: "passkey_unsupported", fallback: "totp" });
    await expect(requestEnrollmentTicket(fetchImpl, "t", "passkey")).rejects.toThrow(
      /passkey_unsupported/,
    );
  });

  it("throws on outages and misshapen success bodies", async () => {
    await expect(
      requestEnrollmentTicket(stubFetch(502, { error: "provider_unavailable" }), "t", "totp"),
    ).rejects.toThrow(/provider_unavailable/);
    await expect(requestEnrollmentTicket(stubFetch(200, {}), "t", "totp")).rejects.toThrow(
      /unexpected shape/,
    );
  });
});
