import { describe, expect, it, vi } from "vitest";
import {
  listSessions,
  readCsrfToken,
  revokeAllSessions,
  revokeOtherSessions,
  revokeSession,
  SessionApiError,
} from "./sessions-client";

interface StubRoute {
  status: number;
  body: unknown;
  assert?: (url: string, init: RequestInit) => void;
}

function stubFetch(route: StubRoute) {
  return vi.fn((url: string, init: RequestInit = {}) => {
    route.assert?.(url, init);
    return Promise.resolve({
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: () =>
        route.body === "<not-json>"
          ? Promise.reject(new Error("Unexpected token"))
          : Promise.resolve(route.body),
    } as Response);
  });
}

const SESSIONS_BODY = {
  sessions: [
    {
      id: "sid-1",
      workspaceId: "ws-1",
      userAgent: "TestBrowser/1.0",
      createdAt: "2026-09-12T10:00:00.000Z",
      lastSeenAt: "2026-09-12T11:00:00.000Z",
      current: true,
      extra: "ignored",
    },
    {
      id: "sid-2",
      workspaceId: null,
      userAgent: null,
      createdAt: "",
      lastSeenAt: "",
      current: false,
    },
  ],
};

describe("readCsrfToken", () => {
  it("reads the double-submit token out of document.cookie", () => {
    expect(readCsrfToken("a=1; __Host-moneo_csrf=tok-123; b=2")).toBe("tok-123");
    expect(readCsrfToken("a=1")).toBeUndefined();
    expect(readCsrfToken("")).toBeUndefined();
  });
});

describe("listSessions", () => {
  it("maps the registry payload, keeping unknown fields out", async () => {
    const fetchImpl = stubFetch({ status: 200, body: SESSIONS_BODY });
    const sessions = await listSessions(fetchImpl, "csrf-token");
    expect(sessions).toEqual([
      {
        id: "sid-1",
        workspaceId: "ws-1",
        userAgent: "TestBrowser/1.0",
        createdAt: "2026-09-12T10:00:00.000Z",
        lastSeenAt: "2026-09-12T11:00:00.000Z",
        current: true,
      },
      {
        id: "sid-2",
        workspaceId: null,
        userAgent: null,
        createdAt: "",
        lastSeenAt: "",
        current: false,
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/sessions", {
      headers: { "x-csrf-token": "csrf-token" },
    });
  });

  it("throws SessionApiError(401) when logged out", async () => {
    const fetchImpl = stubFetch({ status: 401, body: { error: "unauthorized" } });
    const error = await listSessions(fetchImpl, "t").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionApiError);
    expect((error as SessionApiError).status).toBe(401);
  });

  it("throws on server errors, non-JSON and misshapen payloads", async () => {
    await expect(listSessions(stubFetch({ status: 500, body: {} }), "t")).rejects.toThrow(
      SessionApiError,
    );
    await expect(listSessions(stubFetch({ status: 200, body: "<not-json>" }), "t")).rejects.toThrow(
      /non-JSON/,
    );
    await expect(
      listSessions(stubFetch({ status: 200, body: { sessions: {} } }), "t"),
    ).rejects.toThrow(/unexpected shape/);
    await expect(
      listSessions(stubFetch({ status: 200, body: { sessions: [{ nope: true }] } }), "t"),
    ).rejects.toThrow(/unexpected shape/);
  });
});

describe("revokeSession / revokeOtherSessions", () => {
  it("POSTs the exact target with the CSRF header and returns the count", async () => {
    const fetchImpl = stubFetch({ status: 200, body: { revoked: 1 } });
    await expect(revokeSession(fetchImpl, "csrf-token", "sid-2")).resolves.toEqual({ revoked: 1 });
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/sessions/revoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-token" },
      body: JSON.stringify({ sessionId: "sid-2" }),
    });
  });

  it("signs out others with the allOthers flag", async () => {
    const fetchImpl = stubFetch({ status: 200, body: { revoked: 3 } });
    await expect(revokeOtherSessions(fetchImpl, "csrf-token")).resolves.toEqual({ revoked: 3 });
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/sessions/revoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-token" },
      body: JSON.stringify({ allOthers: true }),
    });
  });

  it("maps 401/400/non-JSON to typed errors", async () => {
    await expect(
      revokeSession(stubFetch({ status: 401, body: {} }), "t", "s"),
    ).rejects.toMatchObject({
      status: 401,
    });
    await expect(revokeOtherSessions(stubFetch({ status: 400, body: {} }), "t")).rejects.toThrow(
      /Sign out others failed/,
    );
    await expect(
      revokeSession(stubFetch({ status: 200, body: { revoked: "many" } }), "t", "s"),
    ).rejects.toThrow(/unexpected shape/);
  });
});

describe("signOut", () => {
  it("revokes all Moneo sessions before SDK logout", async () => {
    const fetchImpl = stubFetch({ status: 200, body: { revoked: 2 } });
    await expect(revokeAllSessions(fetchImpl, "csrf-token")).resolves.toEqual({ revoked: 2 });
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/sessions/revoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-token" },
      body: JSON.stringify({ all: true }),
    });
  });

  it("throws on failed or malformed revocation responses", async () => {
    await expect(revokeAllSessions(stubFetch({ status: 500, body: {} }), "t")).rejects.toThrow(
      /Sign out failed/,
    );
    await expect(revokeAllSessions(stubFetch({ status: 200, body: {} }), "t")).rejects.toThrow(
      /unexpected shape/,
    );
  });
});
