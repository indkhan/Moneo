import { afterEach, expect, it, vi } from "vitest";
import { GET } from "./route";
import { createClient } from "@supabase/supabase-js";
import { dispatchFinancialReview } from "@/lib/finance/start-review";
import { DEFAULT_SETTINGS } from "@/lib/settings";
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/finance/start-review", () => ({ dispatchFinancialReview: vi.fn() }));
vi.mock("@/workflows/financial-review", () => ({ financialReview: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.clearAllMocks(); });

it("denies missing/incorrect cron credentials before constructing a service client", async () => {
  vi.stubEnv("CRON_SECRET", "synthetic-secret");
  expect((await GET(new Request("http://localhost/api/cron/summaries"))).status).toBe(401);
  expect((await GET(new Request("http://localhost/api/cron/summaries", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
  expect(createClient).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});

it("dispatches only a new durable claim and marks scheduled execution explicitly", async () => {
  vi.stubEnv("CRON_SECRET", "synthetic-secret");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://synthetic.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-key");
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  const rows = [{ ...DEFAULT_SETTINGS, workspace_id: "own", summary_cadence: "weekly" }];
  const builder = { select: vi.fn(() => builder), neq: vi.fn(() => builder), order: vi.fn(() => builder), limit: vi.fn(async () => ({ data: rows, error: null, count: 1 })) };
  const rpc = vi.fn().mockResolvedValueOnce({ data: "job", error: null }).mockResolvedValueOnce({ data: null, error: null });
  vi.mocked(createClient).mockReturnValue({ from: () => builder, rpc } as unknown as ReturnType<typeof createClient>);
  const request = () => new Request("http://localhost/api/cron/summaries", { headers: { authorization: "Bearer synthetic-secret" } });
  expect(await (await GET(request())).json()).toMatchObject({ started: 1 });
  expect(await (await GET(request())).json()).toMatchObject({ started: 0 });
  expect(dispatchFinancialReview).toHaveBeenCalledTimes(1);
  expect(dispatchFinancialReview).toHaveBeenCalledWith(expect.any(Object), "job", "own", true);
  expect(rpc).toHaveBeenCalledWith("claim_scheduled_summary", { p_workspace_id: "own", p_cadence: "weekly", p_period_start: "2026-09-28" });
});
