import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { importFile } from "./import-file";
import { dispatchFinancialReview } from "@/lib/finance/start-review";
const db = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
const eligibility = vi.hoisted(() => ({ settingsFail: false, modelFail: false, scopesDenied: false }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
vi.mock("@/lib/settings", () => ({ loadWorkspaceSettings: async () => { if (eligibility.settingsFail) throw new Error("settings unavailable"); return {}; }, requireAiScope: () => { if (eligibility.scopesDenied) throw new Error("scopes denied"); } }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: async () => { if (eligibility.modelFail) throw new Error("model catalogue unavailable"); return {}; } }));
vi.mock("@/lib/finance/start-review", () => ({ dispatchFinancialReview: vi.fn() }));
beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "synthetic"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://synthetic.invalid");
  vi.clearAllMocks();
  Object.assign(eligibility, { settingsFail: false, modelFail: false, scopesDenied: false });
  db.rpc.mockResolvedValue({ data: "completed", error: null });
  db.from.mockImplementation((table: string) => {
    const q = { select: () => q, eq: () => q, gt: () => q, order: () => q, limit: () => q, upsert: () => q,
      maybeSingle: async () => ({ data: table === "imports" ? { id: "import" } : null, error: null }) };
    return q;
  });
});
afterEach(() => { vi.unstubAllEnvs(); });
it("dispatches a retained first-review claim when an earlier import step lost its enqueue response", async () => {
  await importFile("import", "workspace", 0);
  expect(dispatchFinancialReview).toHaveBeenCalledWith(db, expect.any(String), "workspace", false);
});
it.each(["settings", "model"])("retries transient %s eligibility failures without failing the completed import", async stage => {
  eligibility.settingsFail = stage === "settings"; eligibility.modelFail = stage === "model";
  await expect(importFile("import", "workspace", 0)).rejects.toThrow("unavailable");
  expect(dispatchFinancialReview).not.toHaveBeenCalled(); expect(db.rpc).toHaveBeenCalledTimes(1);
});
it("skips optional review when current financial evidence scopes are denied", async () => {
  eligibility.scopesDenied = true;
  await importFile("import", "workspace", 0);
  expect(dispatchFinancialReview).not.toHaveBeenCalled();
});
it("lets durable dispatch retry instead of swallowing an ambiguous enqueue failure", async () => {
  vi.mocked(dispatchFinancialReview).mockRejectedValueOnce(new Error("lost enqueue response"));
  await expect(importFile("import", "workspace", 0)).rejects.toThrow("lost enqueue response");
  expect(db.rpc).toHaveBeenCalledTimes(1);
});
