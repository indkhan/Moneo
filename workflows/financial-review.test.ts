import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { financialReview } from "./financial-review";

const fixture = vi.hoisted(() => ({ scheduled: true, disabledAt: 1, loads: 0, writes: [] as { table: string; value: Record<string, unknown> }[] }));
vi.mock("@/lib/settings", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/settings")>();
  return { ...original, loadWorkspaceSettings: async () => original.settingsSchema.parse({ summary_cadence: ++fixture.loads >= fixture.disabledAt ? "none" : "weekly" }) };
});
vi.mock("@/lib/finance/balances", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/finance/balances")>(), loadBalanceEvidence: async () => ({ accounts: [], snapshots: [], ledger: [], asOf: "2026-10-01T12:00:00Z" }) }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: vi.fn(async () => ({})) }));
vi.mock("ai", () => ({ generateText: vi.fn(async () => ({ text: "Evidence review" })) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (table: string) => {
  const query = { select: () => query, eq: () => query, gte: () => query, lte: () => query, order: () => query,
    single: async () => ({ data: { status: "running", cancel_requested: false }, error: null }),
    maybeSingle: async () => ({ data: fixture.scheduled ? { cadence: "weekly" } : null, error: null }),
    range: async () => ({ data: [], error: null }),
    update: (value: Record<string, unknown>) => { fixture.writes.push({ table, value }); return query; },
    upsert: (value: Record<string, unknown>) => { fixture.writes.push({ table, value }); return query; },
    then: (resolve: (value: { data: null; error: null }) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve) };
  return query;
} }) }));
beforeEach(() => { fixture.scheduled = true; fixture.disabledAt = 1; fixture.loads = 0; fixture.writes = []; vi.clearAllMocks(); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test"); });
afterEach(() => vi.unstubAllEnvs());

for (const step of [1, 2, 3]) it(`cancels a scheduled summary disabled before step ${step} without persisting analysis`, async () => {
  fixture.disabledAt = step;
  await financialReview("job", "workspace", true);
  expect(fixture.writes).toContainEqual({ table: "background_jobs", value: expect.objectContaining({ status: "canceled" }) });
  expect(fixture.writes.some(write => write.table === "saved_analyses")).toBe(false);
});
it("keeps a manually requested review available when scheduled summaries are disabled", async () => {
  fixture.scheduled = false;
  await financialReview("job", "workspace");
  expect(fixture.writes.some(write => write.table === "saved_analyses")).toBe(true);
});
