import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { evaluateForecast } from "./tools";
import { toolResultReceipt, toolSourceVersion } from "./tool-evidence";
import { evidenceFreshness } from "./evidence-receipts";
import { loadFinancialReviewEvidence } from "./review-loader";
import { compareReviewEvidence } from "./review-freshness";
import { requireWorkspace } from "@/lib/auth";
import { settingsSchema } from "@/lib/settings";
import { buildCalculatorSnapshot } from "@/lib/artifacts/snapshot";

const fixture = vi.hoisted(() => ({ rate: "1", snapshotVersion: 1, reads: [] as string[] }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({
  workspace: { id: "00000000-0000-4000-8000-000000000001", display_currency: "EUR", timezone: "UTC" },
  settings: settingsSchema.parse({ ai_data_scopes: ["accounts", "transactions", "planning"] }),
  supabase: { from: (table: string) => {
    fixture.reads.push(table);
    const data = table === "accounts" ? [{ id: "cash", name: "Cash", type: "checking", currency_code: "USD", archived_at: null }] :
      table === "balance_snapshots" ? [{ id: "snapshot", account_id: "cash", amount_minor: "1", currency_code: "USD", as_of: "2026-10-01T08:00:00Z", provenance: "manual", version: fixture.snapshotVersion }] :
      table === "fx_rates" ? [{ id: "rate", from_currency: "USD", to_currency: "EUR", rate_text: fixture.rate, rate_date: "2026-10-01", source: "manual" }] : [];
    const query = { select: () => query, eq: () => query, is: () => query, order: () => query, gte: () => query, lte: () => query, in: () => query,
      range: async (from: number, to: number) => ({ data: data.slice(from, to + 1), error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: { permissions: ["forecast"], active_version_id: "v" }, error: null }) };
    return query;
  } },
}) }));
beforeEach(() => { fixture.rate = "1"; fixture.snapshotVersion = 1; fixture.reads = []; vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T12:00:00Z")); });
afterEach(() => vi.useRealTimers());
const receiptContext = { workspaceId: "00000000-0000-4000-8000-000000000001", fetchedAt: "2026-10-01T12:00:00Z", timezone: "UTC" };

it("retains original forecast evidence and marks rounding-invisible rate and snapshot revisions stale", async () => {
  const context = await requireWorkspace();
  const first = await evaluateForecast({ horizonDays: 2 }, context);
  const receipt = toolResultReceipt("forecast_evaluate", { horizonDays: 2 }, first, receiptContext, ["accounts", "transactions", "planning"]);
  fixture.rate = "1.01";
  const changed = await evaluateForecast({ horizonDays: 2 }, context);
  expect(changed.expectedMinor).toBe(first.expectedMinor);
  expect(evidenceFreshness(receipt, toolSourceVersion(changed), receipt.calculationVersion).status).toBe("stale");
  expect(receipt.sources[0].record).toMatchObject({ calculationEvidence: { source: {
    balances: { snapshots: [{ currency_code: "USD", amount_minor: "1", version: 1 }] },
    conversions: expect.arrayContaining([expect.objectContaining({ input: expect.objectContaining({ from: "USD", to: "EUR", amountMinor: "1", rate: "1" }), result: expect.objectContaining({ rate: { numerator: "1", denominator: "1" } }) })]),
  } } });
  fixture.rate = "1"; fixture.snapshotVersion = 2;
  expect(evidenceFreshness(receipt, toolSourceVersion(await evaluateForecast({ horizonDays: 2 }, context)), receipt.calculationVersion).status).toBe("stale");
  expect(fixture.reads).not.toContain("imports"); expect(fixture.reads).not.toContain("source_transactions");
});

it("propagates forecast source changes through real review receipts and review freshness", async () => {
  const { supabase, workspace, settings } = await requireWorkspace();
  const saved = await loadFinancialReviewEvidence(supabase, workspace, settings);
  fixture.rate = "1.01";
  const current = await loadFinancialReviewEvidence(supabase, workspace, settings);
  expect(compareReviewEvidence(saved, current).status).toBe("stale");
  expect(toolSourceVersion(saved)).not.toBe(toolSourceVersion(current));
});

it("retains forecast originals and source revisions in native calculator snapshots", async () => {
  const first = (await buildCalculatorSnapshot("artifact", "trip_planner", { costMinor: 0n })).snapshot;
  fixture.rate = "1.01";
  const changed = (await buildCalculatorSnapshot("artifact", "trip_planner", { costMinor: 0n })).snapshot;
  expect(first).toMatchObject({ calculationEvidence: { source: { balances: { snapshots: [{ currency_code: "USD", version: 1 }] } } }, sourceVersion: expect.any(String) });
  expect(toolSourceVersion(first)).not.toBe(toolSourceVersion(changed));
});
