import {beforeEach, expect, it, vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {DEFAULT_SETTINGS} from "@/lib/settings";
import {resolveReviewRequest} from "./review-request";
import {gatherReviewInvestigation} from "./review-gather";
const fixture = vi.hoisted(() => ({load: vi.fn(), settings: vi.fn(), persist: vi.fn(), forecast: vi.fn()}));
vi.mock("./tools", async original => ({...await original<typeof import("./tools")>(), evaluateForecast: fixture.forecast}));
vi.mock("./investigation-reader", () => ({loadInvestigationDataset: fixture.load}));
vi.mock("./evidence-receipts", async original => ({...await original<typeof import("./evidence-receipts")>(), persistEvidenceReceipt: fixture.persist}));
vi.mock("@/lib/settings", async original => ({...await original<typeof import("@/lib/settings")>(), loadWorkspaceSettings: fixture.settings}));
const workspaceId = "11111111-1111-4111-8111-111111111111";
const request = resolveReviewRequest({version: 1, question: "Explain September", query: {version: 1, period: {from: "2026-09-01", to: "2026-09-30"}}, budget: {maxQueries: 1}}, "2026-10-07");
beforeEach(() => {
  vi.clearAllMocks(); fixture.settings.mockResolvedValue(DEFAULT_SETTINGS);
  fixture.forecast.mockResolvedValue({status: "unavailable", missingInputs: ["estimated spending account"]});
  fixture.persist.mockImplementation(async (_db, receipt) => receipt);
  fixture.load.mockImplementation(async spec => ({spec, rows: [{id: "22222222-2222-4222-8222-222222222222", parentId: "22222222-2222-4222-8222-222222222222", accountId: "owned", categoryId: null, merchantId: null, date: "2026-09-02", amountMinor: "-9007199254740993", currency: "EUR", status: "posted", kind: "ordinary", tags: [], event: null, reviewReasons: [], version: 1, description: "synthetic"}], context: {workspaceId, capturedAt: "2026-10-07T00:00:00Z"}, sourceRevision: "v1"}));
});
const options = () => ({workspaceId, client: vi.fn((signal?: AbortSignal) => {void signal; const query = {select: () => query, eq: () => query, single: async () => ({data: {id: workspaceId, display_currency: "EUR"}, error: null})}; return {from: () => query} as unknown as SupabaseClient;}), checkpoint: vi.fn(async () => {})});
it("reads the frozen dates once, retains exact full receipts and checkpoints only after persistence", async () => {
  const dependencies = options();
  const progress = await gatherReviewInvestigation(request, dependencies);
  expect(fixture.load.mock.calls[0][0].period).toEqual(request.query.period);
  expect(fixture.persist.mock.calls[0][1].metrics[0].valueMinor).toBe("9007199254740993");
  expect(fixture.persist.mock.invocationCallOrder[0]).toBeLessThan(dependencies.checkpoint.mock.invocationCallOrder[1]);
  expect(progress.queries[0].receiptId).toBe(fixture.persist.mock.calls[0][1].id);
  expect(dependencies.client.mock.calls.some(call => call[0] instanceof AbortSignal)).toBe(true);
});
it("withholds newly revoked source scopes and retains an explicit unavailable section", async () => {
  fixture.settings.mockResolvedValueOnce(DEFAULT_SETTINGS).mockResolvedValue({...DEFAULT_SETTINGS, ai_data_scopes: ["accounts", "transactions"]});
  const progress = await gatherReviewInvestigation(request, options());
  expect(fixture.persist).not.toHaveBeenCalled();
  expect(progress.queries[0].status).toBe("unavailable");
  expect(progress.limitations.join(" ")).toContain("unavailable");
});
it("includes requested planning as a spent bounded read with retained missing-input evidence", async () => {
  const selected = resolveReviewRequest({...request, includePlanning: true, budget: {...request.budget, maxQueries: 2}}, "2026-10-07");
  const dependencies = options();
  const progress = await gatherReviewInvestigation(selected, dependencies);
  expect(fixture.forecast).toHaveBeenCalledOnce();
  expect(fixture.forecast.mock.calls[0][0]).toEqual({horizonDays: 30});
  expect(progress.queries).toHaveLength(2);
  expect(progress.queries[1].status).toBe("completed");
  expect(fixture.persist.mock.calls[1][1].scopes).toContain("planning");
  expect(fixture.persist.mock.calls[1][1].limitations[0].message).toBe("estimated spending account");
  const resumed = await gatherReviewInvestigation(selected, dependencies, progress);
  expect(resumed.queries).toHaveLength(2);
  expect(fixture.forecast).toHaveBeenCalledOnce();
});
it("does not expand the frozen read scopes when optional import access is later enabled", async () => {
  const frozen = {...request, allowedScopes: ["accounts", "transactions"] as ["accounts", "transactions"]};
  await gatherReviewInvestigation(frozen, options());
  expect(fixture.load.mock.calls[0][2]).toEqual({canReadImports: false});
  expect(fixture.persist.mock.calls[0][1].scopes).toEqual(["accounts", "transactions"]);
});
it("reports requested planning left unexplored when the query budget is spent", async () => {
  const progress = await gatherReviewInvestigation({...request, includePlanning: true}, options());
  expect(fixture.forecast).not.toHaveBeenCalled();
  expect(progress.limitations.join(" ")).toContain("Requested planning views remain unexplored");
});
it("withholds planning revoked during the read without losing supported spending", async () => {
  fixture.settings.mockResolvedValueOnce(DEFAULT_SETTINGS).mockResolvedValueOnce(DEFAULT_SETTINGS)
    .mockResolvedValueOnce(DEFAULT_SETTINGS).mockResolvedValue({...DEFAULT_SETTINGS, ai_data_scopes: ["accounts", "transactions", "imports"]});
  const progress = await gatherReviewInvestigation({...request, includePlanning: true, budget: {...request.budget, maxQueries: 2}}, options());
  expect(progress.queries.map(query => query.status)).toEqual(["completed", "unavailable"]);
  expect(fixture.forecast).toHaveBeenCalledOnce();
  expect(fixture.persist).toHaveBeenCalledOnce();
});
it("uses explicitly chosen forecast inputs and never widens captured optional imports", async () => {
  const selected = resolveReviewRequest({...request, planningViews: [{view: "forecast", input: {horizonDays: 7, accountId: workspaceId}}],
    allowedScopes: ["accounts", "transactions", "planning"], budget: {...request.budget, maxQueries: 2}}, "2026-10-07");
  await gatherReviewInvestigation(selected, options());
  expect(fixture.forecast.mock.calls[0][0]).toEqual({horizonDays: 7, accountId: workspaceId});
  expect(fixture.forecast.mock.calls[0][1].settings.ai_data_scopes).not.toContain("imports");
  expect(fixture.persist.mock.calls[1][1].scopes).toEqual(["accounts", "transactions", "planning"]);
});
