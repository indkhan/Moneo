import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted((): { role: string | null } => ({ role: "OWNER" }));
vi.mock("@moneo/db/tenancy", () => ({
  withWorkspaceTransaction: async (_workspaceId: string, fn: (tx: object) => Promise<unknown>) =>
    fn({}),
}));
vi.mock("@moneo/db/workspaces", () => ({
  isWorkspaceOwner: async () => mocks.role === "OWNER",
}));

import { AiOwnerRequiredError, requireAiOwner } from "./ai-admin";

describe("AI management authorization", () => {
  it("allows an OWNER to manage AI configuration", async () => {
    mocks.role = "OWNER";
    await expect(
      requireAiOwner(
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ),
    ).resolves.toBeUndefined();
  });

  it.each(["MEMBER", null])("denies %s from managing credentials and policy", async (role) => {
    mocks.role = role;
    await expect(
      requireAiOwner(
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ),
    ).rejects.toBeInstanceOf(AiOwnerRequiredError);
  });
});
