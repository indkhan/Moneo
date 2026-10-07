import { afterEach, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { recoverFinancialReviews } from "@/lib/finance/start-review";
import { GET } from "./route";
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({})) }));
vi.mock("@/lib/finance/start-review", () => ({ recoverFinancialReviews: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it("rejects unauthorized reconciliation before accessing service data", async () => {
  vi.stubEnv("CRON_SECRET", "synthetic");
  expect((await GET(new Request("http://localhost/api/cron/reviews"))).status).toBe(401);
  expect(createClient).not.toHaveBeenCalled();
});
it("reports partial recovery errors for cron monitoring", async () => {
  vi.stubEnv("CRON_SECRET", "synthetic"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://synthetic.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic");
  vi.mocked(recoverFinancialReviews).mockResolvedValue({ scanned: 2, recovered: 1, errors: 1, remaining: 0 });
  const response = await GET(new Request("http://localhost/api/cron/reviews", { headers: { authorization: "Bearer synthetic" } }));
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ recovered: 1, errors: 1 });
});
