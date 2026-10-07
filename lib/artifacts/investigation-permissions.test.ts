import { expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { runInvestigation } from "@/lib/finance/investigation-reader";
import { investigationForArtifact } from "./finance-sdk";
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/finance/investigation-reader", () => ({ runInvestigation: vi.fn() }));
it.each(["permissions", "active_version_id"])("rejects an investigation if artifact %s is revoked while reading", async revoked => {
  let active = true;
  const query = { select: () => query, eq: () => query, single: async () => ({ data: { permissions: active || revoked !== "permissions" ? ["spending"] : [], active_version_id: active || revoked !== "active_version_id" ? "v" : null }, error: null }) };
  vi.mocked(requireWorkspace).mockResolvedValue({ settings: DEFAULT_SETTINGS, workspace: { id: "w" }, supabase: { from: () => query } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  vi.mocked(runInvestigation).mockImplementationOnce(async () => { active = false; return { groups: [] } as unknown as Awaited<ReturnType<typeof runInvestigation>>; });
  await expect(investigationForArtifact("a", {})).rejects.toThrow("Artifact permission denied");
});
