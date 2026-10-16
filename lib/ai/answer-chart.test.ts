import { expect, it } from "vitest";
import { answerChart, answerChartSchema, withAnswerChart } from "./answer-chart";
import type { EvidenceReceipt } from "@/lib/finance/evidence-receipts";

const workspace = "00000000-0000-4000-8000-000000000010";
const metric = (id: string, label: string, valueMinor: string) => ({ id, label, valueMinor, currency: "EUR", period: { from: "2026-09-01", to: "2026-09-30" }, qualifiers: [], sourceIds: [], calculation: "sum" });
const receipt = { id: "r1", workspaceId: workspace, query: { toolName: "analytics_cashflow", input: { accountId: "00000000-0000-4000-8000-000000000003" } },
  metrics: [metric("incomeMinor", "Income", "5000"), metric("spendingMinor", "Spending", "1250"), metric("x.netMinor", "Net cashflow", "3750")] } as unknown as EvidenceReceipt;
const claim = (metricId: string, valueMinor: string, unit = "money") => ({ operation: "metric", operands: [{ receiptId: "r1", metricId }], valueMinor, currency: "EUR", unit });

it("charts only accepted money metrics that match their evidence and links filtered transactions", () => {
  const chart = answerChart([claim("incomeMinor", "5000"), claim("spendingMinor", "1250"), claim("x.netMinor", "999"), claim("incomeMinor", "5000", "count")], [receipt], workspace)!;
  expect(answerChartSchema.parse(chart)).toEqual(chart);
  expect(chart.rows.map(row => row.valueMinor)).toEqual(["5000", "1250"]);
  expect(chart.rows[1].href).toBe("/money/transactions?from=2026-09-01&to=2026-09-30&direction=outflow&account=00000000-0000-4000-8000-000000000003");
  expect(answerChart([claim("incomeMinor", "5000")], [receipt], workspace)).toBeNull();
  expect(answerChart([claim("incomeMinor", "5000"), claim("spendingMinor", "1250")], [receipt], "00000000-0000-4000-8000-000000000011")).toBeNull();
});

it("places the chart before the evidence trail", () => {
  const chart = answerChart([claim("incomeMinor", "5000"), claim("spendingMinor", "1250")], [receipt], workspace);
  const body = withAnswerChart("Measured facts\n\n- a\n\nEvidence trail\n\n- link", chart);
  expect(body.indexOf("```moneo-chart")).toBeLessThan(body.indexOf("Evidence trail"));
  expect(withAnswerChart("Plain", null)).toBe("Plain");
});
