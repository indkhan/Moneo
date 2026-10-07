import { describe, expect, it } from "vitest";
import { publishFinancialClaims, type FinancialEvidenceReceipt } from "./verified-claims";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const receipt: FinancialEvidenceReceipt = {
  id: "00000000-0000-4000-8000-000000000002", workspaceId,
  fetchedAt: "2026-10-01T00:00:00Z", calculationVersion: "cashflow-v1", sourceVersion: "v1",
  query: { from: "2026-09-01", to: "2026-09-30" },
  sources: [{ id: "00000000-0000-4000-8000-000000000003", type: "transaction", version: "1", href: "/money/transactions?transaction=00000000-0000-4000-8000-000000000003" }],
  metrics: [{ id: "spending", label: "Spending", valueMinor: "9007199254740993", currency: "EUR", period: { from: "2026-09-01", to: "2026-09-30" }, qualifiers: ["partial_classification"], sourceIds: ["00000000-0000-4000-8000-000000000003"], calculation: "sum reviewed booked spending less refunds" }],
};
const metric = { receiptId: receipt.id, metricId: "spending" };
const fact = { operation: "metric", operands: [metric], valueMinor: "9007199254740993", currency: "EUR", periods: [receipt.metrics[0].period], qualifiers: ["partial_classification"], sourceIds: receipt.metrics[0].sourceIds };
const publish = (claims: unknown[], receipts = [receipt]) => publishFinancialClaims({ claims, interpretation: [] }, receipts, workspaceId);

describe("financial publication trust boundary", () => {
  it("explains exact evidence-specific comparisons with composed unproven hypotheses and checks", () => {
    const previous = { ...receipt.metrics[0], id: "previous", valueMinor: "9007199254740990", period: { from: "2026-08-01", to: "2026-08-31" } };
    const evidence = { ...receipt, metrics: [...receipt.metrics, previous] };
    const explanation = { action: "explain", observation: { kind: "comparison", first: metric, second: { receiptId: receipt.id, metricId: "previous" }, relationship: "higher" }, hypotheses: ["refund_timing", "one_off_activity"], uncertainty: "unproven", nextSteps: ["timing", "supporting_records"] };
    const claims = [fact, { ...fact, operands: [explanation.observation.second], valueMinor: previous.valueMinor, periods: [previous.period] }];
    const result = publishFinancialClaims({ claims, interpretation: [explanation] }, [evidence], workspaceId);
    expect(result.removed).toBe(0);
    expect(result.body).toContain("is EUR 0.03 higher");
    expect(result.body).toContain("2026-08-01 to 2026-08-31");
    expect(result.body).toContain("Possible explanation (unproven)");
    expect(result.body).toContain("related refunds fell in different periods");
    expect(result.body).toContain("retained measures do not establish these causes");
    for (const patch of [{ uncertainty: "confirmed" }, { observation: { ...explanation.observation, relationship: "lower" } }, { text: "Your groceries doubled EUR999999 [proof](/invented)" }, { hypotheses: ["your_spending_doubled"] }]) {
      const rejected = publishFinancialClaims({ claims, interpretation: [{ ...explanation, ...patch }] }, [evidence], workspaceId);
      expect(rejected.removed).toBe(1);
      expect(rejected.body).not.toContain("999999");
      expect(rejected.body).not.toContain("/invented");
    }
    expect(publishFinancialClaims({ claims: [fact], interpretation: [explanation] }, [evidence], workspaceId).removed).toBe(1);
    const limits = publishFinancialClaims({ claims: [fact], interpretation: [{ action: "explain", observation: { kind: "limits", reference: metric }, uncertainty: "unproven", hypotheses: ["classification"], nextSteps: ["supporting_records"] }] }, [receipt], workspaceId);
    expect(limits.removed).toBe(0);
    expect(limits.body).toContain("Limits on [Spending");
    expect(limits.body).toContain("neither upper nor lower bounds");
  });
  it("renders exact application amounts, calculation links and unavoidable qualifications", () => {
    const result = publish([fact]);
    expect(result.accepted).toHaveLength(1);
    expect(result.body).toContain("EUR 90071992547409.93");
    expect(result.body).toContain(`/ai/evidence/${receipt.id}?metric=spending`);
    expect(result.body).toContain("Partial classification");
  });
  it.each([{ currency: "USD", unit: "money" }, { currency: "EUR", unit: "count" }])("rejects explanatory comparisons across currencies or units %j", variant => {
    const other = { ...receipt.metrics[0], id: "other", currency: variant.currency, unit: variant.unit as "money" | "count", valueMinor: "1" };
    const reference = { receiptId: receipt.id, metricId: "other" };
    const result = publishFinancialClaims({ claims: [fact, { ...fact, operands: [reference], valueMinor: "1", currency: variant.currency, unit: variant.unit }], interpretation: [{ action: "explain", observation: { kind: "comparison", first: metric, second: reference, relationship: "higher" }, uncertainty: "unproven", hypotheses: ["timing"] }] }, [{ ...receipt, metrics: [...receipt.metrics, other] }], workspaceId);
    expect(result.accepted).toHaveLength(2);
    expect(result.removed).toBe(1);
    expect(result.body).not.toContain("Possible explanation");
  });
  it.each([
    { valueMinor: "99999900" }, { currency: "USD" }, { periods: [{ from: "2026-08-01", to: "2026-08-31" }] },
    { qualifiers: [] }, { sourceIds: ["00000000-0000-4000-8000-000000000099"] },
    { href: "/money/transactions?transaction=nonexistent" },
  ])("visibly removes invalid assertions %j without publishing their prose", patch => {
    const result = publish([{ ...fact, ...patch }]);
    expect(result.accepted).toHaveLength(0);
    expect(result.body).toContain("Unsupported sections were removed");
    expect(result.body).not.toContain("999999");
    expect(result.body).not.toContain("nonexistent");
  });
  it("rejects foreign workspace evidence before resolving any metric", () => {
    expect(publish([fact], [{ ...receipt, workspaceId: "00000000-0000-4000-8000-000000000099" }]).accepted).toHaveLength(0);
  });
  it("computes differences with exact arithmetic and checks reported direction", () => {
    const previous = { ...receipt.metrics[0], id: "previous", valueMinor: "9007199254740990", period: { from: "2026-08-01", to: "2026-08-31" } };
    const evidence = { ...receipt, metrics: [...receipt.metrics, previous] };
    const claim = { ...fact, operation: "difference", operands: [metric, { receiptId: receipt.id, metricId: "previous" }], valueMinor: "3", periods: [fact.periods[0], previous.period], direction: "increase" };
    expect(publish([claim], [evidence]).body).toContain("EUR 0.03");
    expect(publish([{ ...claim, valueMinor: "4" }], [evidence]).accepted).toHaveLength(0);
    expect(publish([{ ...claim, direction: "decrease" }], [evidence]).accepted).toHaveLength(0);
  });
  it("rejects cross-currency arithmetic and unavailable metrics", () => {
    const other = { ...receipt.metrics[0], id: "other", currency: "USD" };
    expect(publish([{ ...fact, operation: "sum", operands: [metric, { receiptId: receipt.id, metricId: "other" }] }], [{ ...receipt, metrics: [...receipt.metrics, other] }]).accepted).toHaveLength(0);
    expect(publish([fact], [{ ...receipt, metrics: [{ ...receipt.metrics[0], valueMinor: null }] }]).accepted).toHaveLength(0);
  });
  it("does not accept unrestricted prose as measured facts or interpretation", () => {
    const result = publishFinancialClaims({ claims: [fact], interpretation: [{ text: "Groceries doubled. [proof](/made-up)" }] }, [receipt], workspaceId);
    expect(result.body).not.toContain("Groceries doubled");
    expect(result.body).not.toContain("made-up");
    expect(result.accepted).toHaveLength(1);
  });
  it("allows separately labelled conditional interpretation grounded in accepted metrics", () => {
    const result = publishFinancialClaims({ claims: [fact], interpretation: [{ action: "review", reference: metric, topic: "classification" }] }, [receipt], workspaceId);
    expect(result.body).toContain("Interpretation");
    expect(result.body).toContain("Consider reviewing");
    expect(result.body).toContain("classification");
  });
  it("formats record counts as counts and never treats them as minor-unit currency", () => {
    const evidence = { ...receipt, metrics: [{ ...receipt.metrics[0], id: "count", unit: "count" as const, valueMinor: "3" }] };
    const claim = { ...fact, unit: "count", operands: [{ receiptId: receipt.id, metricId: "count" }], valueMinor: "3" };
    expect(publish([claim], [evidence]).body).toContain("3 records");
    expect(publish([claim], [evidence]).body).not.toContain("EUR 0.03");
  });
});
