import { afterEach, expect, it, vi } from "vitest";
import { start } from "workflow/api";
import { serviceDb } from "@/lib/bank/server";
import { GET } from "./route";

vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/bank-sync", () => ({ syncBankConnection: vi.fn() }));
vi.mock("@/lib/bank/enable-banking", () => ({ enableBankingConfigured: () => true }));
vi.mock("@/lib/bank/server", () => ({ serviceDb: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("denies missing or incorrect cron credentials before reading connections", async () => {
  vi.stubEnv("CRON_SECRET", "synthetic-secret");
  expect((await GET(new Request("http://localhost/api/cron/bank-sync"))).status).toBe(401);
  expect((await GET(new Request("http://localhost/api/cron/bank-sync", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
  expect(serviceDb).not.toHaveBeenCalled();
});

it("starts one background sync per active connection, without PSU headers", async () => {
  vi.stubEnv("CRON_SECRET", "synthetic-secret");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://synthetic.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-key");
  const builder = { select: vi.fn(() => builder), eq: vi.fn(() => builder), order: vi.fn(() => builder),
    limit: vi.fn(async () => ({ data: [{ id: "c1", workspace_id: "w1" }, { id: "c2", workspace_id: "w2" }], error: null })) };
  vi.mocked(serviceDb).mockReturnValue({ from: () => builder } as never);
  const response = await GET(new Request("http://localhost/api/cron/bank-sync", { headers: { authorization: "Bearer synthetic-secret" } }));
  expect(await response.json()).toEqual({ started: 2, failed: 0 });
  expect(builder.eq).toHaveBeenCalledWith("status", "active");
  expect(vi.mocked(start).mock.calls.map(call => call[1])).toEqual([["c1", "w1"], ["c2", "w2"]]);
});
