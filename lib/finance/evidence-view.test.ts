import { expect, it, vi } from "vitest";
import type { requireWorkspace } from "@/lib/auth";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { createEvidenceReceipt } from "./evidence-receipts";
import { readEvidenceView } from "./evidence-view";
const fixture = vi.hoisted(() => ({ load: vi.fn(), cashflow: vi.fn(), forecast: vi.fn() }));
vi.mock("./evidence-receipts", async original => ({ ...await original<typeof import("./evidence-receipts")>(), loadEvidenceReceipt: fixture.load }));
vi.mock("./tools", async original => ({ ...await original<typeof import("./tools")>(), cashflow: fixture.cashflow, evaluateForecast: fixture.forecast }));
const workspaceId = "00000000-0000-4000-8000-000000000001";
const result = { from: "2026-09-01", to: "2026-09-30", currencyCode: "EUR", spendingMinor: "25" };
const context = { workspace: { id: workspaceId, timezone: "UTC" }, settings: DEFAULT_SETTINGS, supabase: {} } as Awaited<ReturnType<typeof requireWorkspace>>;
it("loads actual owned calculations and support and marks changed evidence stale while preserving retained values", async () => {
  const { toolResultReceipt } = await import("./tool-evidence");
  const saved = toolResultReceipt("analytics_cashflow", {}, result, { workspaceId, timezone: "UTC", fetchedAt: "2026-10-01T00:00:00Z" }, ["transactions"]);
  fixture.load.mockResolvedValue(saved); fixture.cashflow.mockResolvedValue(result);
  const view = await readEvidenceView(context, saved.id, saved.metrics[0].id);
  expect(view?.freshness.status).toBe("current");
  expect(view?.metric?.valueMinor).toBe("25");
  expect(view?.supportingRecords[0].record).toEqual(result);
  fixture.cashflow.mockResolvedValue({ ...result, spendingMinor: "26" });
  expect((await readEvidenceView(context, saved.id))?.freshness.status).toBe("stale");
  expect(saved.metrics[0].valueMinor).toBe("25");
});
it("withholds revoked or missing receipts and never substitutes a nonexistent metric", async () => {
  const saved = createEvidenceReceipt({ workspaceId, fetchedAt: "2026-10-01T00:00:00Z", scopes: ["transactions"], query: { kind: "tool" }, sourceVersion: "v1", calculationVersion: "v1", sources: [], metrics: [] });
  fixture.load.mockResolvedValue(saved);
  await expect(readEvidenceView({ ...context, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: [] } }, saved.id)).rejects.toThrow(/disabled/);
  await expect(readEvidenceView(context, saved.id, "invented")).rejects.toThrow(/metric/i);
  fixture.load.mockResolvedValue(null);
  expect(await readEvidenceView(context, saved.id)).toBeNull();
});
it("replays forecast freshness under its recorded optional import policy", async () => {
  const {toolResultReceipt} = await import("./tool-evidence");
  const result = {status: "unavailable", missingInputs: ["dated input"]};
  const saved = toolResultReceipt("forecast_evaluate", {horizonDays: 7}, result, {workspaceId, timezone: "UTC", fetchedAt: "2026-10-01T00:00:00Z"}, ["accounts", "transactions", "planning"]);
  fixture.load.mockResolvedValue(saved); fixture.forecast.mockResolvedValue(result);
  await readEvidenceView(context, saved.id);
  expect(fixture.forecast.mock.calls.at(-1)?.[1].settings.ai_data_scopes).not.toContain("imports");
});
it("replays bounded selected goal evidence and detects changes to dated manual savings", async () => {
  const {toolResultReceipt} = await import("./tool-evidence");
  const goal = {id: workspaceId, name: "Synthetic", currency_code: "EUR", target_minor: "9007199254740993", recorded_saved_minor: "25", saved_as_of: "2026-09-01"};
  const input = {goalIds: [workspaceId], limit: 1};
  const saved = toolResultReceipt("goals_review", input, {goals: [goal]}, {workspaceId, timezone: "UTC", fetchedAt: "2026-10-01T00:00:00Z"}, ["planning"]);
  fixture.load.mockResolvedValue(saved);
  let current = goal;
  const query = {select: () => query, eq: () => query, order: () => query, limit: () => query, in: () => query,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({data: [current], error: null}).then(resolve)};
  const scoped = {...context, supabase: {from: () => query}} as unknown as typeof context;
  expect((await readEvidenceView(scoped, saved.id))?.freshness.status).toBe("current");
  current = {...goal, recorded_saved_minor: "26"};
  expect((await readEvidenceView(scoped, saved.id))?.freshness.status).toBe("stale");
  expect(saved.metrics.find(metric => metric.id.endsWith("recorded_saved_minor"))).toMatchObject({valueMinor: "25", period: {from: "2026-09-01", to: "2026-09-01"}, qualifiers: expect.arrayContaining(["manual_evidence", "dated_snapshot"])});
});
