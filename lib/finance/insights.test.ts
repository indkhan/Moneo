import { describe, expect, it } from "vitest";
import { buildInsights, defaultInsightPreferences, DEFAULT_INSIGHT_PREFERENCES, type InsightInput } from "./insights";

const base: InsightInput = { today: "2026-10-02", currency: "EUR", transactions: [], categories: [], budgets: [], recurring: [], obligations: [], goals: [], wealth: [], missingInputs: [], available: null };
describe("deterministic evidence-backed insights", () => {
  it("keeps an unsaved comparison threshold at twenty major units in its explicit currency", () => {
    expect(defaultInsightPreferences("EUR").minimum_change_minor).toBe("2000");
    expect(defaultInsightPreferences("JPY").minimum_change_minor).toBe("20");
    expect(defaultInsightPreferences("IQD").minimum_change_minor).toBe("20000");
  });
  it("supports each requested type from credible dated evidence without cross-currency guessing", () => {
    const transactions = Array.from({ length: 10 }, (_, index) => ({ id: `prior${index}`, parent_transaction_id: `prior${index}`, amount_minor: "-1000", currency_code: "EUR", account_id: "account", status: "posted", kind: "ordinary", review_reasons: [], posted_on: "2026-09-30", category_id: "food", merchant_id: null }));
    transactions.push({ ...transactions[0], id: "large", parent_transaction_id: "large", amount_minor: "-30000", posted_on: "2026-10-02" });
    const insights = buildInsights({ ...base, transactions, categories: [{ id: "food", name: "Food" }],
      budgets: [{ id: "budget", name: "Food", currency: "EUR", spentMinor: "30000", allowanceMinor: "20000", partial: false }],
      recurring: [{ id: "series", label: "Subscription", evidence_invalidated: true }],
      obligations: [{ id: "bill", date: "2026-10-03", amountMinor: "-5000", currency: "EUR", name: "Confirmed bill" }],
      goals: [{ id: "goal", name: "Reserve", targetMinor: "10000", savedMinor: "10000", savedAsOf: "2026-10-02" }],
      wealth: [{ id: "debt", name: "Debt", kind: "debt", amountMinor: "-100000", currency: "EUR", asOf: "2026-10-02" }],
      missingInputs: ["Current bank balance missing"], available: { amountMinor: "-500", limitingDate: "2026-10-04" },
    }, { ...DEFAULT_INSIGHT_PREFERENCES, important_only: false, max_items: 20 });
    expect(new Set(insights.map(item => item.type))).toEqual(new Set(["spending_changes", "budget_pressure", "unusual_activity", "recurring_changes", "upcoming_obligations", "cash_shortfall", "goal_progress", "asset_debt", "data_quality"]));
    expect(insights.find(item => item.type === "unusual_activity")?.detail).toContain("EUR 300.00");
  });
  it("requires comparable samples and excludes ambiguous, pending and transfer evidence", () => {
    const rows = ["pending", "posted"].map((status, index) => ({ id: String(index), amount_minor: "-9007199254740993", currency_code: "USD", status, kind: "ordinary", review_reasons: ["source_type"], posted_on: "2026-10-02", category_id: null, merchant_id: null }));
    expect(buildInsights({ ...base, transactions: rows }, DEFAULT_INSIGHT_PREFERENCES)).toEqual([]);
  });
  it("deduplicates unchanged evidence but permits renewed insight after a correction and honors mute/relevance limits", () => {
    const input = { ...base, available: { amountMinor: "-100", limitingDate: "2026-10-03" } };
    const first = buildInsights(input, DEFAULT_INSIGHT_PREFERENCES)[0];
    expect(buildInsights(input, DEFAULT_INSIGHT_PREFERENCES)[0].key).toBe(first.key);
    expect(buildInsights({ ...input, available: { ...input.available, amountMinor: "-200" } }, DEFAULT_INSIGHT_PREFERENCES)[0].key).not.toBe(first.key);
    expect(buildInsights(input, DEFAULT_INSIGHT_PREFERENCES, ["cash_shortfall"])).toEqual([]);
    expect(buildInsights({ ...base, missingInputs: ["one", "two"] }, { ...DEFAULT_INSIGHT_PREFERENCES, max_items: 1 })).toHaveLength(1);
  });
  it("does not flag unused zero budgets and suppresses comparisons when an uncertain uncategorized row could belong to the category", () => {
    expect(buildInsights({ ...base, budgets: [{ id: "zero", name: "Unused", currency: "EUR", spentMinor: "0", allowanceMinor: "0", partial: false }] }, DEFAULT_INSIGHT_PREFERENCES)).toEqual([]);
    const row = { id: "prior", amount_minor: "-10000", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [], posted_on: "2026-09-29", category_id: "food", merchant_id: null };
    const input = { ...base, categories: [{ id: "food", name: "Food" }], transactions: [row, { ...row, id: "now", amount_minor: "-20000", posted_on: "2026-10-02" }] };
    expect(buildInsights(input, DEFAULT_INSIGHT_PREFERENCES).some(item => item.type === "spending_changes")).toBe(true);
    expect(buildInsights({ ...input, transactions: [...input.transactions, { ...row, id: "uncertain", posted_on: "2026-10-01", category_id: null, review_reasons: ["source_type"] }] }, DEFAULT_INSIGHT_PREFERENCES).some(item => item.type === "spending_changes")).toBe(false);
  });
  it("rounds an even expense median half up before applying the three-times threshold", () => {
    const row = { id: "candidate", amount_minor: "-3002", currency_code: "EUR", account_id: "account", status: "posted", kind: "ordinary", review_reasons: [], posted_on: "2026-10-02", category_id: null, merchant_id: null };
    const peers = Array.from({ length: 10 }, (_, i) => ({ ...row, id: `peer${i}`, posted_on: "2026-09-29", amount_minor: i < 5 ? "-1000" : "-1001" }));
    const preferences = { ...DEFAULT_INSIGHT_PREFERENCES, minimum_change_minor: "0" };
    expect(buildInsights({ ...base, transactions: [...peers, row] }, preferences).some(item => item.type === "unusual_activity")).toBe(false);
    expect(buildInsights({ ...base, transactions: [...peers, { ...row, amount_minor: "-3003" }] }, preferences).find(item => item.type === "unusual_activity")?.detail).toContain("rounded half up");
  });
  it("fills relevance limits from undismissed evidence beyond the first twenty candidates and renews corrected old recurring evidence", () => {
    const input = { ...base, missingInputs: Array.from({ length: 25 }, (_, i) => `Missing ${i}`) };
    const dismissed = buildInsights(input, { ...DEFAULT_INSIGHT_PREFERENCES, max_items: 20 }).map(item => item.key);
    const next = buildInsights(input, { ...DEFAULT_INSIGHT_PREFERENCES, max_items: 1 }, [], dismissed);
    expect(next).toHaveLength(1);
    expect(dismissed).not.toContain(next[0].key);
    const recurring = { id: "old-series", label: "Old recurring", evidence_invalidated: true, evidence: [{ id: "old-row", posted_on: "2025-01-01", amount_minor: "-1000" }] };
    const first = buildInsights({ ...base, recurring: [recurring] }, DEFAULT_INSIGHT_PREFERENCES)[0];
    expect(buildInsights({ ...base, recurring: [{ ...recurring, evidence: [{ ...recurring.evidence[0], amount_minor: "-2000" }] }] }, DEFAULT_INSIGHT_PREFERENCES, [], [first.key])).toHaveLength(1);
  });
});
