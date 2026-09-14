import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireStrongAuth: vi.fn(),
  StrongAuthError: class StrongAuthError extends Error {
    constructor(
      readonly code: "SIGNED_OUT" | "NOT_ENROLLED" | "DEGRADED",
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("./strong-auth", () => mocks);

import { financeRoute } from "./finance-api";
import { StrongAuthError } from "./strong-auth";

describe("financeRoute", () => {
  it.each([
    ["SIGNED_OUT", 401],
    ["NOT_ENROLLED", 403],
    ["DEGRADED", 503],
  ] as const)("fails closed for %s", async (code, status) => {
    mocks.requireStrongAuth.mockRejectedValueOnce(new StrongAuthError(code, "locked"));

    const response = await financeRoute(async () => Response.json({ reachable: true }));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: code, message: "locked" });
  });

  it("passes the verified workspace session to the finance handler", async () => {
    mocks.requireStrongAuth.mockResolvedValueOnce({
      session: { uid: "user-1", wid: "workspace-1" },
      status: { state: "enrolled" },
    });

    const response = await financeRoute(async (session) =>
      Response.json({ workspaceId: session.wid }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ workspaceId: "workspace-1" });
  });
});
