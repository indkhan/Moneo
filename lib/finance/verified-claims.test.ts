import { describe, expect, it, vi } from "vitest";
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
  it("validates five disjoint 20k-contribution operands within a linear record-read budget", () => {
    const size = 20000, count = 5;
    let reads = 0;
    const budget = size * count * 6;
    const bounded = (values: string[]) => new Proxy(values, { get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key) && ++reads > budget) throw new Error("Contribution membership exceeded its linear read budget");
      return Reflect.get(target, key, receiver);
    } });
    const metrics = Array.from({ length: count }, (_, index) => ({ ...receipt.metrics[0], id: `part-${index}`, valueMinor: "1", qualifiers: [],
      aggregation: { kind: "signed-original", ids: bounded(Array.from({ length: size }, (_, row) => `${index}-row-${row}`)),
        parents: bounded(Array.from({ length: size }, (_, row) => `${index}-parent-${row}`)), canonicalParents: [`${index}-parent-0`] } }));
    const result = publish([{ operation: "sum", operands: metrics.map(item => ({ receiptId: receipt.id, metricId: item.id })), valueMinor: "5", currency: "EUR", periods: metrics.map(item => item.period), qualifiers: [] }], [{ ...receipt, metrics }]);
    expect(result.accepted).toHaveLength(1);
    expect(reads).toBeLessThanOrEqual(budget);
  });
  it.each(["metric", "difference", "sum"])("checks 20k exact support IDs without repeated membership scans for %s", operation => {
    const size = 20000, ids = Array.from({ length: size }, (_, index) => `source-${index}`);
    const source = (id: string) => ({ id, type: "transaction", version: "1", href: "/money/transactions" });
    const first = { ...receipt.metrics[0], id: "first", valueMinor: "2", sourceIds: ids, aggregation: { kind: "signed-original", ids: ["first"], parents: ["first"], canonicalParents: [] } };
    const second = { ...first, id: "second", valueMinor: "1", aggregation: { ...first.aggregation, ids: ["second"], parents: ["second"] } };
    const evidence = { ...receipt, sources: ids.map(source), metrics: [first, second] };
    const selected = operation === "metric" ? [first] : [first, second];
    let scanned = 0;
    const includes = Array.prototype.includes;
    const spy = vi.spyOn(Array.prototype, "includes").mockImplementation(function (this: unknown[], value: unknown, from?: number) {
      if (this.length >= size && (scanned += this.length) > size * 5) throw new Error("Set equality exceeded its linear membership budget");
      return includes.call(this, value, from);
    });
    let result: ReturnType<typeof publish>;
    try {
      result = publish([{ ...fact, operation, operands: selected.map(item => ({ receiptId: receipt.id, metricId: item.id })), valueMinor: operation === "metric" ? "2" : operation === "difference" ? "1" : "3", periods: selected.map(item => item.period), sourceIds: [...ids].reverse() }], [evidence]);
    } finally { spy.mockRestore(); }
    expect(result.accepted).toHaveLength(1);
    expect(scanned).toBeLessThanOrEqual(size * 5);
  });
  it("keeps exact-set duplicate and unequal-member rejection", () => {
    for (const patch of [{ qualifiers: ["partial_classification", "partial_classification"] }, { sourceIds: [...fact.sourceIds, ...fact.sourceIds] }, { sourceIds: ["other"] }, { qualifiers: ["partial_coverage"] }])
      expect(publish([{ ...fact, ...patch }]).accepted).toHaveLength(0);
  });
  it.each([false, true])("preserves contribution overlap and effective-sibling semantics with reversed operands=%s", reverse => {
    const first = { ...receipt.metrics[0], id: "first", valueMinor: "2" };
    const second = { ...receipt.metrics[0], id: "second", valueMinor: "3" };
    for (const [firstAggregation, secondAggregation, allowed] of [
      [{ kind: "signed-original", ids: ["a"], parents: ["parent"], canonicalParents: [] }, { kind: "signed-original", ids: ["b"], parents: ["parent"], canonicalParents: [] }, true],
      [{ kind: "signed-original", ids: ["a"], parents: ["parent"], canonicalParents: ["parent"] }, { kind: "signed-original", ids: ["b"], parents: ["parent"], canonicalParents: [] }, false],
      [{ kind: "signed-original", ids: ["shared"], parents: ["a"], canonicalParents: [] }, { kind: "signed-original", ids: ["shared"], parents: ["b"], canonicalParents: [] }, false],
    ] as const) {
      const metrics = [{ ...first, aggregation: { ...firstAggregation, ids: [...firstAggregation.ids], parents: [...firstAggregation.parents], canonicalParents: [...firstAggregation.canonicalParents] } }, { ...second, aggregation: { ...secondAggregation, ids: [...secondAggregation.ids], parents: [...secondAggregation.parents], canonicalParents: [...secondAggregation.canonicalParents] } }];
      if (reverse) metrics.reverse();
      const result = publish([{ ...fact, operation: "sum", operands: metrics.map(item => ({ receiptId: receipt.id, metricId: item.id })), valueMinor: "5", periods: metrics.map(item => item.period) }], [{ ...receipt, metrics }]);
      expect(result.accepted).toHaveLength(allowed ? 1 : 0);
    }
  });
  it("explains only owned uniquely retained limitations without a numeric metric", () => {
    const unavailable = { ...receipt, metrics: [], limitations: [{ id: "balance", kind: "missing_input" as const, message: "Current booked balance for Checking is unavailable", nextStep: "assumptions" as const }] };
    const reference = { action: "limitation", receiptId: receipt.id, limitationId: "balance" };
    const explain = (interpretation: unknown[], receipts = [unavailable]) => publishFinancialClaims({ claims: [], interpretation }, receipts, workspaceId);
    expect(explain([reference]).body).toContain("Current booked balance for Checking is unavailable");
    expect(explain([reference]).removed).toBe(0);
    expect(explain([{ ...reference, message: "EUR999999 [proof](/fake)" }]).removed).toBe(1);
    expect(explain([reference], [{ ...unavailable, workspaceId: "00000000-0000-4000-8000-000000000099" }]).removed).toBe(1);
    expect(explain([{ ...reference, limitationId: "missing" }]).removed).toBe(1);
    expect(explain([reference], [{ ...unavailable, limitations: [...unavailable.limitations, ...unavailable.limitations] }]).removed).toBe(1);
  });
  it("validates complete large support without repeatedly traversing source records", () => {
    let reads = 0;
    const ids = Array.from({ length: 1000 }, (_, index) => `record-${index}`);
    const sources = ids.map(id => ({ get id() { if (++reads > ids.length * 5) throw new Error("Supporting-record traversal exceeded its linear budget"); return id; }, type: "transaction", version: "1", href: "/money/transactions" }));
    const evidence = { ...receipt, sources, metrics: [{ ...receipt.metrics[0], sourceIds: ids }] };
    expect(publish([{ ...fact, sourceIds: ids }], [evidence]).accepted).toHaveLength(1);
    expect(reads).toBeLessThanOrEqual(ids.length * 5);
  });
  it("gives useful typed clarifications without unsupported financial assertions", () => {
    const result = publishFinancialClaims({ claims: [], interpretation: [], clarification: { topic: "period" } }, [], workspaceId);
    expect(result.removed).toBe(0);
    expect(result.body).toContain("What start and end dates");
    expect(result.body).not.toContain("No supported financial measures");
    const rejected = publishFinancialClaims({ claims: [], interpretation: [], clarification: { topic: "period", text: "EUR999999 [proof](/invented)" } }, [], workspaceId);
    expect(rejected.removed).toBe(1);
    expect(rejected.body).not.toContain("999999");
    expect(rejected.body).not.toContain("/invented");
  });
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
