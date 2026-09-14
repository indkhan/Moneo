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
  AiOwnerRequiredError: class AiOwnerRequiredError extends Error {
    constructor() {
      super("Only a workspace owner can manage AI settings and credentials.");
    }
  },
}));
vi.mock("./strong-auth", () => ({
  requireStrongAuth: mocks.requireStrongAuth,
  StrongAuthError: mocks.StrongAuthError,
}));
vi.mock("./ai-admin", () => ({ AiOwnerRequiredError: mocks.AiOwnerRequiredError }));

import { aiRoute } from "./ai-api";
import { AiOwnerRequiredError } from "./ai-admin";

describe("aiRoute", () => {
  it("returns 403 when a non-owner reaches an AI management action", async () => {
    mocks.requireStrongAuth.mockResolvedValueOnce({
      session: { uid: "user-1", wid: "workspace-1" },
    });

    const response = await aiRoute(async () => {
      throw new AiOwnerRequiredError();
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "forbidden",
      message: "Only a workspace owner can manage AI settings and credentials.",
    });
  });
});
