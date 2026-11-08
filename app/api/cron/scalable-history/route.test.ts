import { afterEach, expect, it, vi } from "vitest";
import { serviceDb } from "@/lib/bank/server";
import { rebuildScalableHistory } from "@/lib/scalable/history-job";
import { GET } from "./route";

vi.mock("@/lib/bank/server", () => ({ serviceDb: vi.fn() }));
vi.mock("@/lib/scalable/server", () => ({ scalableConfigured: () => true }));
vi.mock("@/lib/scalable/history-job", () => ({ rebuildScalableHistory: vi.fn(async () => "saved") }));
vi.mock("@/lib/settings", () => ({ loadWorkspaceSettings: async () => ({ timezone: "Europe/Berlin" }) }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

const row = (id: string, history_status: string | null, history_checked_on: string | null) => ({ id, workspace_id: "w", portfolio: {}, history_status, history_checked_on });
const request = (secret = "synthetic-secret") => new Request("http://localhost/api/cron/scalable-history", { headers: { authorization: `Bearer ${secret}` } });
const setup = (rows: ReturnType<typeof row>[]) => {
  vi.stubEnv("CRON_SECRET", "synthetic-secret");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://synthetic.supabase.co");
  const builder = { select: vi.fn(() => builder), eq: vi.fn(() => builder), order: vi.fn(() => builder), limit: vi.fn(async () => ({ data: rows, error: null })) };
  vi.mocked(serviceDb).mockReturnValue({ from: () => builder } as never);
};

it("is refused without the cron secret", async () => {
  setup([]);
  expect((await GET(request("wrong"))).status).toBe(401);
  vi.stubEnv("CRON_SECRET", "");
  expect((await GET(new Request("http://localhost/api/cron/scalable-history"))).status).toBe(401);
});

it("runs each connection without a good history once per workspace day", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-07T23:30:00Z"), toFake: ["Date"] }); // already Nov 8 in Berlin
  setup([row("new", null, null), row("done", "ok", "2026-11-01"), row("tried-today", "failed", "2026-11-08"), row("tried-yesterday", "failed", "2026-11-07")]);
  const response = await GET(request());
  expect(await response.json()).toEqual({ saved: 2, failed: 0, skipped: 0 });
  expect(vi.mocked(rebuildScalableHistory).mock.calls.map(call => [call[0].id, call[1], call[2]])).toEqual([["new", "Europe/Berlin", "2026-11-08"], ["tried-yesterday", "Europe/Berlin", "2026-11-08"]]);
});

it("carries on after a connection fails", async () => {
  setup([row("a", null, null), row("b", null, null), row("c", null, null)]);
  vi.mocked(rebuildScalableHistory).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("failed").mockResolvedValueOnce("skipped");
  const response = await GET(request());
  expect(await response.json()).toEqual({ saved: 0, failed: 2, skipped: 1 });
  expect(rebuildScalableHistory).toHaveBeenCalledTimes(3);
});
