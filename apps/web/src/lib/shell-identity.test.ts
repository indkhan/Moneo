import { describe, expect, it, vi } from "vitest";
vi.mock("./auth-session", () => ({
  getSession: () => Promise.reject(mockedSessionError ?? new Error("No session")),
}));
import {
  getShellIdentity,
  identityLabel,
  resolveShellIdentity,
  type ShellUser,
} from "./shell-identity";
import type { SessionPayload } from "./auth-session";

let mockedSessionError: Error | null = null;

function session(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sub: "auth0|abc",
    email: "a@example.com",
    name: "Ada",
    uid: "user-1",
    wid: "ws-1",
    sid: "sid-1",
    iat: 1_000,
    exp: 2_000,
    ...overrides,
  };
}

describe("resolveShellIdentity", () => {
  it("returns a logged-out identity for a missing session without touching the DB", async () => {
    const lookup = vi.fn(() => Promise.resolve({ id: "ws-1", name: "W" }));
    expect(await resolveShellIdentity(null, lookup)).toEqual({ user: null, workspace: null });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("maps session claims onto the user, preferring stored profile fields", async () => {
    const lookup = vi.fn(() => Promise.resolve({ id: "ws-1", name: "Workspace One" }));
    const identity = await resolveShellIdentity(session(), lookup);
    expect(identity).toEqual({
      user: { id: "user-1", sub: "auth0|abc", email: "a@example.com", name: "Ada" },
      workspace: { id: "ws-1", name: "Workspace One" },
    });
    expect(lookup).toHaveBeenCalledWith("ws-1");
  });

  it("omits empty profile fields and keeps a null user id for legacy sessions", async () => {
    const lookup = vi.fn(() => Promise.resolve(null));
    const identity = await resolveShellIdentity(
      session({ email: "", name: undefined, uid: undefined, wid: undefined }),
      lookup,
    );
    expect(identity.user).toEqual({ id: null, sub: "auth0|abc" });
    expect(identity.workspace).toBeNull();
    // No workspace in the session: no lookup issued.
    expect(lookup).not.toHaveBeenCalled();
  });

  it("shows the user with a pending workspace when the lookup finds nothing", async () => {
    const identity = await resolveShellIdentity(
      session(),
      vi.fn(() => Promise.resolve(null)),
    );
    expect(identity.user?.sub).toBe("auth0|abc");
    expect(identity.workspace).toBeNull();
  });

  it("keeps rendering the user when the database is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const lookup = vi.fn(() => Promise.reject(new Error("connection refused")));
      const identity = await resolveShellIdentity(session(), lookup);
      expect(identity.user?.sub).toBe("auth0|abc");
      expect(identity.workspace).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Shell workspace lookup failed"));
    } finally {
      warn.mockRestore();
    }
  });

  it("passes the session workspace id to the lookup untouched", async () => {
    const lookup = vi.fn((id: string) => Promise.resolve({ id, name: "W" }));
    await resolveShellIdentity(session({ wid: "ws-exact-9" }), lookup);
    expect(lookup).toHaveBeenCalledWith("ws-exact-9");
  });
});

describe("identityLabel", () => {
  it("prefers name, then email, then the raw subject", () => {
    const base: ShellUser = { id: "u", sub: "auth0|abc" };
    expect(identityLabel({ ...base, name: "Ada", email: "a@x.com" })).toBe("Ada");
    expect(identityLabel({ ...base, email: "a@x.com" })).toBe("a@x.com");
    expect(identityLabel(base)).toBe("auth0|abc");
  });
});

describe("getShellIdentity wiring", () => {
  it("renders logged-out when the Auth0 session cannot be read", async () => {
    mockedSessionError = new Error("Auth0 is not configured");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(getShellIdentity()).resolves.toEqual({ user: null, workspace: null });
    } finally {
      mockedSessionError = null;
      warn.mockRestore();
    }
  });
});
