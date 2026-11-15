import { afterEach, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ requireWorkspace: workspace }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
import SetupPage from "./page";

afterEach(() => vi.resetAllMocks());

it("sends an authenticated workspace home when setup has recovered", async () => {
  workspace.mockResolvedValue({ workspace: { id: "workspace" } });
  await expect(SetupPage()).rejects.toThrow("redirect:/");
});

it("keeps recovery available when the workspace is unavailable", async () => {
  workspace.mockRejectedValue(new Error("Workspace unavailable"));
  expect(await SetupPage()).toBeTruthy();
});
