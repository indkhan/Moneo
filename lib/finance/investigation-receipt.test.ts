import { expect, it } from "vitest";
import { investigationSchema, type InvestigationRow } from "./investigation";
import { investigationReceipt } from "./investigation-receipt";
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
