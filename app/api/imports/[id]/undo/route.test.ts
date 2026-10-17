import { beforeEach, expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";
import { serviceDb } from "@/lib/bank/server";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/bank/server", () => ({ serviceDb: vi.fn() }));

const updates: { values: unknown; filters: unknown[][] }[] = [];

beforeEach(() => {
  updates.length = 0;
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
  const imports = { select: () => imports, eq: () => imports, maybeSingle: async () => ({ data: { mapping: { accountName: "Revolut ••6254" } }, error: null }) };
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "ws-1" }, supabase: {
    rpc: async () => ({ data: { status: "undone" }, error: null }), from: () => imports,
  } } as never);
  vi.mocked(serviceDb).mockReturnValue({ from: () => ({ update: (values: unknown) => {
    const entry = { values, filters: [] as unknown[][] }; updates.push(entry);
    const builder = { eq: (...args: unknown[]) => { entry.filters.push(args); return builder; }, then: (resolve: (value: unknown) => void) => resolve({ error: null }) };
    return builder;
  } }) } as never);
});

const undo = () => POST(new Request("http://localhost/api/imports/i1/undo", { method: "POST", body: JSON.stringify({ confirm: true, expectedTransactions: 14, expectedBalances: 0 }) }),
  { params: Promise.resolve({ id: "i1" }) });

it("restarts the bank sync window for the undone import's account", async () => {
  expect((await undo()).status).toBe(200);
  expect(updates).toEqual([{ values: { last_booked_on: null }, filters: [["workspace_id", "ws-1"], ["account_name", "Revolut ••6254"]] }]);
});
