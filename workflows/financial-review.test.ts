import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { financialReview } from "./financial-review";
import { generateText } from "ai";
import { modelForSettings } from "@/lib/ai/provider";

const fixture = vi.hoisted(() => ({ scheduled: true, disabledAt: 1, importsLoaded: false, disabledImportsAt: Infinity, loads: 0, finishStatus: "completed", writes: [] as { table: string; value: Record<string, unknown> }[] }));
vi.mock("workflow", async original => ({ ...await original<typeof import("workflow")>(), getWorkflowMetadata: () => ({ workflowRunId: "run" }), getStepMetadata: () => ({ attempt: 1 }) }));
vi.mock("@/lib/finance/review-loader", () => ({ loadFinancialReviewEvidence: async () => ({ period: { from: "2026-07-05", to: "2026-10-02" }, sourceCoverage: { importStatuses: fixture.importsLoaded ? { completed: 1 } : null }, planning: { unavailable: "Disabled" } }) }));
vi.mock("@/lib/settings", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/settings")>();
  return { ...original, loadWorkspaceSettings: async () => original.settingsSchema.parse({ summary_cadence: ++fixture.loads >= fixture.disabledAt ? "none" : "weekly",
    ai_data_scopes: fixture.loads >= fixture.disabledImportsAt ? ["accounts", "transactions", "planning"] : ["accounts", "transactions", "planning", "imports"] }) };
});
vi.mock("@/lib/finance/balances", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/finance/balances")>(), loadBalanceEvidence: async () => ({ accounts: [], snapshots: [], ledger: [], asOf: "2026-10-01T12:00:00Z" }) }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: vi.fn(async () => ({})) }));
vi.mock("ai", async original => ({ ...await original<typeof import("ai")>(), generateText: vi.fn(async () => ({ text: "Evidence review" })) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: async (name: string, value: Record<string, unknown>) => { fixture.writes.push({ table: name, value }); return { data: name === "register_financial_review_run" ? true : fixture.finishStatus, error: null }; }, from: (table: string) => {
  const query = { select: () => query, eq: () => query, in: () => query, gte: () => query, lte: () => query, order: () => query,
    single: async () => ({ data: { status: "running", cancel_requested: false, workflow_run_id: "run" }, error: null }),
    maybeSingle: async () => ({ data: table === "background_jobs" ? {id: "job"} : fixture.scheduled ? { cadence: "weekly" } : null, error: null }),
    range: async () => ({ data: [], error: null }),
    update: (value: Record<string, unknown>) => { fixture.writes.push({ table, value }); return query; },
    upsert: (value: Record<string, unknown>) => { fixture.writes.push({ table, value }); return query; },
    then: (resolve: (value: { data: null; error: null }) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve) };
  return query;
} }) }));
beforeEach(() => { fixture.scheduled = true; fixture.disabledAt = 1; fixture.importsLoaded = false; fixture.disabledImportsAt = Infinity; fixture.loads = 0; fixture.finishStatus = "completed"; fixture.writes = []; vi.clearAllMocks(); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test"); });
afterEach(() => vi.unstubAllEnvs());

it.each([2, 3])("withholds actual source metadata when import access is revoked before review step %s", async step => {
  fixture.scheduled = false; fixture.importsLoaded = true; fixture.disabledImportsAt = step;
  await expect(financialReview("job", "workspace")).rejects.toThrow(/imports/);
  expect(fixture.writes.some(write => write.table === "finish_financial_review")).toBe(false);
  expect(generateText).toHaveBeenCalledTimes(step === 2 ? 0 : 1);
});

for (const step of [1, 2, 3]) it(`cancels a scheduled summary disabled before step ${step} without persisting analysis`, async () => {
  fixture.disabledAt = step;
  await financialReview("job", "workspace", true);
  expect(fixture.writes).toContainEqual({ table: "background_jobs", value: expect.objectContaining({ status: "canceled" }) });
  expect(fixture.writes.some(write => write.table === "saved_analyses")).toBe(false);
});
it("keeps a manually requested review available when scheduled summaries are disabled", async () => {
  fixture.scheduled = false;
  await financialReview("job", "workspace");
  expect(fixture.writes.some(write => write.table === "finish_financial_review")).toBe(true);
  expect(fixture.writes.some(write => write.table === "saved_analyses")).toBe(false);
});
it("accepts atomic cancellation during final save without separately completing a job", async () => {
  fixture.scheduled = false; fixture.finishStatus = "canceled";
  await financialReview("job", "workspace");
  expect(fixture.writes.some(write => write.table === "finish_financial_review")).toBe(true);
  expect(fixture.writes.some(write => write.value.status === "completed")).toBe(false);
});
it("bounds provider attempts and marks a token-limited saved review as incomplete", async () => {
  fixture.scheduled = false;
  vi.mocked(generateText).mockResolvedValueOnce({ text: "Partial review", finishReason: "length" } as unknown as Awaited<ReturnType<typeof generateText>>);
  await financialReview("job", "workspace");
  expect(vi.mocked(generateText).mock.calls[0][0]).toMatchObject({ maxRetries: 0, abortSignal: expect.any(AbortSignal) });
  expect(modelForSettings).toHaveBeenCalledWith(expect.anything(), { effort: "minimal", exclude: true });
  expect(fixture.writes.find(write => write.table === "finish_financial_review")?.value.p_body).toContain("Incomplete review");
});
