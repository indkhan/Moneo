import { describe, expect, it } from "vitest";
import { createToolRegistry } from "./tool-registry.js";

describe("AI tool registry", () => {
  it("injects workspace identity instead of accepting it from model input", async () => {
    const registry = createToolRegistry([
      {
        name: "accounts.list",
        scopes: ["finance:read"],
        execute: ({ workspaceId }) => workspaceId,
      },
    ]);
    await expect(
      registry.execute(
        "accounts.list",
        {},
        { workspaceId: "server-workspace", scopes: ["finance:read"] },
      ),
    ).resolves.toBe("server-workspace");
    await expect(
      registry.execute(
        "accounts.list",
        { workspaceId: "forged" },
        { workspaceId: "server-workspace", scopes: ["finance:read"] },
      ),
    ).rejects.toThrow("workspaceId");
  });
});
