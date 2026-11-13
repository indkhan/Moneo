import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { start } from "workflow/api";
import { syncScalable } from "@/lib/scalable/sync";
import { POST } from "./route";

const tables: Record<string, Record<string, unknown>[]> = {};
vi.mock("workflow/api", () => ({ start: vi.fn(async () => ({ returnValue: Promise.resolve() })) }));
vi.mock("@/workflows/bank-sync", () => ({ syncBankConnection: vi.fn() }));
vi.mock("@/lib/bank/enable-banking", () => ({ enableBankingConfigured: async () => true }));
// The lease another trigger already holds; claim_bank_sync refuses those.
const leased = new Set<string>();
vi.mock("@/lib/bank/server", () => ({ psuFrom: () => ({ ip: "127.0.0.1", userAgent: "test" }),
  serviceDb: () => ({ rpc: async (_name: string, args: { p_connection_id: string }) => ({ data: !leased.has(args.p_connection_id), error: null }) }) }));
vi.mock("@/lib/scalable/server", () => ({ scalableConfigured: () => true }));
vi.mock("@/lib/scalable/sync", () => ({ syncScalable: vi.fn(async () => ({})) }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w" }, supabase: { from: (table: string) => {
  const query = { select: () => query, eq: () => query, then: (resolve: (value: unknown) => unknown) => resolve({ data: tables[table], error: null }) };
  return query;
} } }) }));

const now = Date.parse("2026-11-08T12:00:00Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const open = async () => (await POST(new Request("http://localhost/api/sync/open", { method: "POST" }))).json();
// Each test uses its own ids because the route remembers what it just tried.
const connections = (scalable: { id: string; last_synced_at: string | null }[], banks: { id: string; last_synced_at: string | null }[]) => {
  tables.scalable_connections = scalable;
  tables.bank_connections = banks.map(bank => ({ last_attempted_at: null, ...bank }));
};

beforeEach(() => { vi.useFakeTimers({ now, toFake: ["Date"] }); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-key"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("syncs Scalable after 15 minutes and a bank after an hour, as the user present, and asks for a refresh", async () => {
  connections([{ id: "s-old", last_synced_at: ago(16) }, { id: "s-new", last_synced_at: ago(14) }],
    [{ id: "b-old", last_synced_at: ago(180) }, { id: "b-new", last_synced_at: ago(59) }]);
  expect(await open()).toEqual({ refresh: true });
  expect(vi.mocked(syncScalable).mock.calls).toEqual([["s-old", "w"]]);
  expect(vi.mocked(start).mock.calls.map(call => call[1])).toEqual([["b-old", "w", expect.any(String), { ip: "127.0.0.1", userAgent: "test" }]]);
});

it("does nothing and asks for no refresh when everything is fresh", async () => {
  connections([{ id: "s-fresh", last_synced_at: ago(1) }], [{ id: "b-fresh", last_synced_at: ago(1) }]);
  expect(await open()).toEqual({ refresh: false });
  expect(syncScalable).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it("does not sync copied connections when opening an explicit desktop preview", async () => {
  vi.stubEnv("MONEO_DESKTOP", "1");
  vi.stubEnv("MONEO_DESKTOP_PREVIEW", "1");
  connections([{ id: "s-preview", last_synced_at: ago(180) }], [{ id: "b-preview", last_synced_at: ago(180) }]);
  expect(await open()).toEqual({ refresh: false });
  expect(syncScalable).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

// Opening Moneo while Sync now, the hourly job or a new consent was starting the same bank used to start a second sync.
it("leaves a bank another trigger is already syncing alone", async () => {
  leased.add("b-running");
  connections([], [{ id: "b-running", last_synced_at: ago(180) }]);
  expect(await open()).toEqual({ refresh: false });
  expect(start).not.toHaveBeenCalled();
});

it("refreshes after a failed sync so Home can say so, and does not retry on every open", async () => {
  connections([{ id: "s-fails", last_synced_at: ago(600) }], []);
  vi.mocked(syncScalable).mockRejectedValueOnce(new Error("Scalable is down"));
  expect(await open()).toEqual({ refresh: true });
  expect(await open()).toEqual({ refresh: false });
  expect(syncScalable).toHaveBeenCalledTimes(1);
});
