import { afterEach, expect, it, vi } from "vitest";
import { start } from "workflow/api";
import { serviceDb } from "@/lib/bank/server";
import { GET } from "./route";

vi.mock("workflow/api", () => ({ start: vi.fn(async () => ({ runId: "run" })) }));
vi.mock("@/workflows/bank-sync", () => ({ syncBankConnection: vi.fn() }));
vi.mock("@/lib/bank/enable-banking", () => ({ enableBankingConfigured: async () => true }));
vi.mock("@/lib/bank/server", () => ({ serviceDb: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("denies missing or incorrect cron credentials before reading connections", async () => {
  vi.stubEnv("CRON_SECRET", "synthetic-secret");
  expect((await GET(new Request("http://localhost/api/cron/bank-sync"))).status).toBe(401);
  expect((await GET(new Request("http://localhost/api/cron/bank-sync", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
  expect(serviceDb).not.toHaveBeenCalled();
});

// One account's rate limit used to hold every account of its bank for 20 hours, and the others never synced.
// Banks connected at different hours synced at different hours, and each sync started its own agent run.
it("starts a background sync for each connection with an account due, and the workspace's other banks with it", async () => {
  vi.stubEnv("CRON_SECRET", "synthetic-secret");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://synthetic.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-key");
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const account = (connection_id: string, last_attempted_at: string | null, next_allowed_at: string | null = null, workspace_id = `w-${connection_id}`) => ({ connection_id, workspace_id, last_attempted_at, next_allowed_at });
  const rows = [account("tried-a-day-ago", ago(21)), account("tried-recently", ago(2)), account("bank-asked-to-wait", null, ago(-1)),
    account("one-account-due", ago(2)), account("one-account-due", ago(25)), account("already-syncing", null),
    account("second-bank", ago(13), null, "w-tried-a-day-ago"), account("second-bank-too-soon", ago(8), null, "w-tried-a-day-ago"), account("alone-half-a-day", ago(13))];
  const builder = { select: vi.fn(() => builder), eq: vi.fn(() => builder), order: vi.fn(() => builder), limit: vi.fn(async () => ({ data: rows, error: null })) };
  const rpc = vi.fn(async (_name: string, args: { p_connection_id: string }) => ({ data: args.p_connection_id !== "already-syncing", error: null }));
  vi.mocked(serviceDb).mockReturnValue({ from: () => builder, rpc } as never);
  const response = await GET(new Request("http://localhost/api/cron/bank-sync", { headers: { authorization: "Bearer synthetic-secret" } }));
  expect(await response.json()).toEqual({ started: 3, busy: 1, failed: 0 });
  expect(builder.eq).toHaveBeenCalledWith("bank_connections.status", "active");
  const args = vi.mocked(start).mock.calls.map(call => call[1] as unknown[]);
  expect(args.map(call => call.slice(0, 2))).toEqual([["tried-a-day-ago", "w-tried-a-day-ago"], ["one-account-due", "w-one-account-due"], ["second-bank", "w-tried-a-day-ago"]]);
  expect(args.every(call => call[3] === undefined && call[4] === true)).toBe(true);
});
