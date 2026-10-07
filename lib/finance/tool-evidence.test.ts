import { expect, it } from "vitest";
import { toolResultReceipt, providerFinancialAnswer } from "./tool-evidence";
const context = { workspaceId: "00000000-0000-4000-8000-000000000001", fetchedAt: "2026-10-01T00:00:00Z", timezone: "UTC" };
it("retains every query input/result and derives only exact typed monetary facts", () => {
  const result = { from: "2026-09-01", to: "2026-09-30", currencyCode: "EUR", spendingMinor: "9007199254740993", sourceCoverage: { financialCompleteness: "unknown" }, evidence: { partial: true, excludedReviewRows: 2 } };
  const receipt = toolResultReceipt("analytics_cashflow", { from: result.from, to: result.to, currencyCode: "EUR" }, result, context, ["transactions"]);
  expect(receipt.query.result).toEqual(result);
  expect(receipt.query.input).toEqual({ from: result.from, to: result.to, currencyCode: "EUR" });
  expect(receipt.metrics).toContainEqual(expect.objectContaining({ label: "Spending", valueMinor: result.spendingMinor, period: { from: result.from, to: result.to }, qualifiers: ["partial_coverage", "partial_classification"] }));
  expect(receipt.sources[0].record).toEqual(result);
});
it("preserves unresolved source posting uncertainty without calling its amount spending", () => {
  const receipt = toolResultReceipt("transactions_search", { query: "transfer" }, [{ id: "00000000-0000-4000-8000-000000000002", posted_on: "2026-09-01", amount_minor: "-25", currency_code: "EUR", kind: "ordinary", classificationStatus: "unresolved", review_reasons: ["source_transfer"], effectiveRows: [] }], context, ["transactions"]);
  expect(receipt.metrics[0]).toMatchObject({ label: "Recorded source posting", qualifiers: ["partial_coverage", "unresolved_included", "source_posting"] });
  expect(receipt.metrics[0].label).not.toBe("Spending");
});
it("malformed provider prose visibly falls back to supported financial measures and never publishes invented links", () => {
  const receipt = toolResultReceipt("analytics_cashflow", {}, { from: "2026-09-01", to: "2026-09-30", currencyCode: "EUR", spendingMinor: "25" }, context, ["transactions"]);
  const result = providerFinancialAnswer("EUR 999999.00 [proof](/made-up)", [receipt], context.workspaceId);
  expect(result.body).toContain("EUR 0.25");
  expect(result.body).toContain("Unsupported sections were removed");
  expect(result.body).not.toContain("999999");
  expect(result.body).not.toContain("made-up");
});
it("exposes per-currency review totals without inventing a display-currency net worth", () => {
  const receipt = toolResultReceipt("reviews_investigate", {}, { period: { from: "2026-09-01", to: "2026-09-30" }, cashflow: { EUR: { spendingMinor: "10" }, USD: { incomeMinor: "20" } }, netWorth: { EUR: "30", USD: null } }, context, ["accounts", "transactions"]);
  expect(receipt.metrics).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Spending", currency: "EUR", valueMinor: "10" }), expect.objectContaining({ label: "Income", currency: "USD", valueMinor: "20" }), expect.objectContaining({ label: "Net worth", currency: "EUR", valueMinor: "30" })]));
});
it("retains forecast horizons, budget month scopes and dated manual savings instead of borrowing the review period", () => {
  const forecast = toolResultReceipt("forecast_evaluate", {}, { currencyCode: "EUR", period: { from: "2026-10-01", to: "2026-10-30" }, expectedMinor: "10" }, context, ["accounts", "transactions", "planning"]);
  expect(forecast.metrics[0].period).toEqual({ from: "2026-10-01", to: "2026-10-30" });
  const review = toolResultReceipt("reviews_investigate", {}, { period: { from: "2026-07-01", to: "2026-09-30" }, planning: { budgets: [{ currency: "EUR", month: "2026-09", spentMinor: "25" }], goals: [{ currency: "EUR", recordedSavedMinor: "30", savedAsOf: "2026-08-05" }] } }, context, ["accounts", "transactions", "planning"]);
  expect(review.metrics.find(metric => metric.label === "Booked budget spending")?.period).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  expect(review.metrics.find(metric => metric.label === "Dated recorded savings")).toMatchObject({ valueMinor: "30", period: { from: "2026-08-05", to: "2026-08-05" }, qualifiers: expect.arrayContaining(["manual_evidence", "dated_snapshot"]) });
  const future = toolResultReceipt("reviews_investigate", {}, { budgets: [{ currency: "EUR", month: "2026-11", limitMinor: "30" }] }, context, ["planning"]);
  expect(future.metrics[0]).toMatchObject({ period: { from: "2026-11-01", to: "2026-11-30" }, qualifiers: expect.arrayContaining(["assumption"]) });
});

it("renders actual action and import statuses without accepting provider prose or hrefs", () => {
  const created = toolResultReceipt("artifacts_create", {}, { id: "00000000-0000-4000-8000-000000000002", href: "/invented" }, context, []);
  expect(providerFinancialAnswer('{"claims":[],"interpretation":[]}', [created], context.workspaceId).body).toContain("/ai/library/00000000-0000-4000-8000-000000000002");
  const imports = toolResultReceipt("imports_status", {}, { imports: [{ id: "00000000-0000-4000-8000-000000000003", status: "completed", total_rows: 20, classification_review_rows: 2 }] }, context, ["imports"]);
  const body = providerFinancialAnswer("Your finances are complete EUR 999999", [imports], context.workspaceId).body;
  expect(body).toContain("Recorded processing status: completed");
  expect(body).toContain("2 rows need classification review");
  expect(body).not.toContain("999999");
});
