import { expect, it } from "vitest";
import { investigationSchema, type InvestigationRow } from "./investigation";
import { investigationReceipt } from "./investigation-receipt";
import { providerFinancialAnswer } from "./tool-evidence";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const spec = investigationSchema.parse({ version: 1, period: { from: "2026-09-01", to: "2026-09-30" }, comparison: { from: "2026-08-01", to: "2026-08-31" }, page: { size: 1 }, groupBy: ["category"] });
const rows: InvestigationRow[] = Array.from({ length: 3 }, (_, index) => ({ id: `00000000-0000-4000-8000-00000000000${index + 2}`, parentId: `00000000-0000-4000-8000-00000000000${index + 2}`, accountId: "owned", categoryId: null, merchantId: null, date: index ? "2026-09-02" : "2026-08-02", amountMinor: "-10", currency: "EUR", status: "posted", kind: "ordinary", tags: [], event: null, reviewReasons: [], version: 1, description: "Synthetic" }));
it("retains full exact selected support beyond display pages and both named periods", () => {
  const receipt = investigationReceipt({ spec, rows, context: { workspaceId, capturedAt: "2026-10-01T00:00:00Z", sourceCoverage: { status: "unknown" } }, sourceRevision: "v1" }, ["accounts", "transactions"]);
  expect(receipt.sources).toHaveLength(3);
  expect(receipt.metrics.find(metric => metric.id.endsWith("current"))).toMatchObject({ valueMinor: "20", sourceIds: rows.slice(1).map(row => row.id), period: spec.period, qualifiers: ["partial_coverage"] });
  expect(receipt.metrics.find(metric => metric.id.endsWith("comparison"))).toMatchObject({ valueMinor: "10", sourceIds: [rows[0].id], period: spec.comparison });
  expect(receipt.metrics.find(metric => metric.id.endsWith("delta"))).toMatchObject({ valueMinor: "10", sourceIds: rows.map(row => row.id), period: spec.period });
  expect(receipt.query.spec).toEqual({ ...spec, page: { size: 25, period: "both" } });
});
it.each(["missing-rate", "ambiguous-rate", "invalid-rate"])("retains actual %s conversion blockers with actionable clarification", reason => {
  const selected = investigationSchema.parse({ version: 1, period: spec.period, comparison: spec.comparison, currencyPolicy: { mode: "base", currency: "EUR" } });
  const foreign = { ...rows[1], currency: "USD" };
  const rate = { id: "rate", fromCurrency: "USD", toCurrency: "EUR", rateDate: foreign.date, rateText: reason === "invalid-rate" ? "bad" : "1", source: "manual" };
  const receipt = investigationReceipt({ spec: selected, rows: [rows[0], foreign], context: { workspaceId, capturedAt: "2026-10-01T00:00:00Z", rates: reason === "missing-rate" ? [] : reason === "ambiguous-rate" ? [rate, { ...rate, id: "other" }] : [rate] }, sourceRevision: "v1" }, ["transactions"]);
  expect(receipt.metrics.find(metric => metric.id.endsWith("current"))?.valueMinor).toBeNull();
  expect(receipt.metrics.find(metric => metric.id.endsWith("comparison"))?.valueMinor).toBe("10");
  expect(receipt.limitations).toContainEqual(expect.objectContaining({ kind: "unavailable", message: expect.stringContaining(reason) }));
  const answer = providerFinancialAnswer("Spending is EUR999999", [receipt], workspaceId).body;
  expect(answer).toContain("USD to EUR");
  expect(answer).toContain(foreign.date);
  expect(answer).toContain("direct posting-date rate");
  expect(answer).not.toContain("999999");
});
it("retains full long filters and grouped labels without overflowing descriptive metadata", () => {
  const tags = Array.from({ length: 100 }, (_, index) => `${index}:${"a".repeat(100)}`);
  const selected = investigationSchema.parse({ version: 1, period: spec.period, tags: { include: tags }, groupBy: ["tag"] });
  const receipt = investigationReceipt({ spec: selected, rows: [{ ...rows[1], tags: tags.slice(0, 5) }], context: { workspaceId, capturedAt: "2026-10-01T00:00:00Z" }, sourceRevision: "v1" }, ["transactions"]);
  expect(receipt.metrics[0].label.length).toBeLessThanOrEqual(200);
  expect(receipt.query.spec).toEqual(selected);
  expect(receipt.query.groups).toEqual([expect.objectContaining({ dimensions: { tag: tags.slice(0, 5) } })]);
});
it("explains a wholly unavailable conversion without manufacturing a numeric result", () => {
  const selected = investigationSchema.parse({ version: 1, period: spec.period, currencyPolicy: { mode: "base", currency: "EUR" } });
  const receipt = investigationReceipt({ spec: selected, rows: [{ ...rows[1], currency: "USD" }], context: { workspaceId, capturedAt: "2026-10-01T00:00:00Z" }, sourceRevision: "v1" }, ["transactions"]);
  const answer = providerFinancialAnswer("Spending is EUR999999", [receipt], workspaceId);
  expect(answer.accepted).toHaveLength(0);
  expect(answer.body).toContain("missing-rate");
  expect(answer.body).toContain("choose original-currency analysis");
  expect(answer.body).not.toContain("999999");
});
it("does not report currency conversion as blocking an exact record count", () => {
  const selected = investigationSchema.parse({ version: 1, period: spec.period, metric: "count", currencyPolicy: { mode: "base", currency: "EUR" } });
  const receipt = investigationReceipt({ spec: selected, rows: [{ ...rows[1], currency: "USD" }], context: { workspaceId, capturedAt: "2026-10-01T00:00:00Z" }, sourceRevision: "v1" }, ["transactions"]);
  expect(receipt.metrics[0]).toMatchObject({ valueMinor: "1", unit: "count" });
  expect(receipt.limitations ?? []).toHaveLength(0);
});
