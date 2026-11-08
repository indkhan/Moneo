import { afterEach, expect, it, vi } from "vitest";
import { serviceDb } from "@/lib/bank/server";
import { syncScalable } from "@/lib/scalable/sync";
import { GET } from "./route";

vi.mock("@/lib/bank/server", () => ({ serviceDb: vi.fn() }));
vi.mock("@/lib/scalable/server", () => ({ scalableConfigured: () => true }));
vi.mock("@/lib/scalable/sync", () => ({ syncScalable: vi.fn(async () => ({})) }));
vi.mock("@/lib/settings", () => ({ loadWorkspaceSettings: async () => ({ timezone: "Europe/Berlin" }) }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("syncs whatever is not from today in the workspace's timezone, however few hours ago that was", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-08T11:41:00Z"), toFake: ["Date"] });
  vi.stubEnv("CRON_SECRET", "synthetic-secret");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://synthetic.supabase.co");
  const rows = [
    { id: "yesterday", workspace_id: "w", last_synced_at: "2026-11-07T22:59:00Z" }, // 23:59 in Berlin, under 13 hours ago
    { id: "today", workspace_id: "w", last_synced_at: "2026-11-07T23:01:00Z" }, // 00:01 in Berlin
    { id: "never", workspace_id: "w", last_synced_at: null },
  ];
  const builder = { select: vi.fn(() => builder), eq: vi.fn(() => builder), order: vi.fn(() => builder), limit: vi.fn(async () => ({ data: rows, error: null })) };
  vi.mocked(serviceDb).mockReturnValue({ from: () => builder } as never);
  const response = await GET(new Request("http://localhost/api/cron/scalable-sync", { headers: { authorization: "Bearer synthetic-secret" } }));
  expect(await response.json()).toEqual({ synced: 2, failed: 0 });
  expect(vi.mocked(syncScalable).mock.calls.map(call => call[0])).toEqual(["yesterday", "never"]);
});
