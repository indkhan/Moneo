import { expect, it } from "vitest";
import { buildReviewEvidence, buildReviewInvestigation, buildPlanningReview, reviewNetWorth } from "./review";

it("uses recorded rollover history and preserves unknown carry when targets or classifications are missing", () => {
  const input = { today: "2026-03-01", goals: [], allocations: [], categories: [],
    budgets: [{ id: "b", category_id: "c", currency_code: "EUR", limit_minor: "1000", enabled: true, rollover: true, rollover_from: "2026-01-01" }],
    transactions: [{ id: "old", posted_on: "2026-01-01", amount_minor: "-200", currency_code: "EUR", status: "posted", kind: "ordinary", category_id: "c", merchant_id: null }],
    budgetHistory: [{ plan_id: "b", effective_month: "2026-01-01", limit_minor: "1000", enabled: true, version: 1 }] };
  expect(buildPlanningReview(input).budgets[0]).toMatchObject({ carriedMinor: "1800", allowanceMinor: "2800", remainingMinor: "2800", partial: false });
  expect(buildPlanningReview({ ...input, budgetHistory: [] }).budgets[0]).toMatchObject({ remainingMinor: null, partial: true, overLimit: null });
  expect(buildPlanningReview({ ...input, transactions: [{ ...input.transactions[0], review_reasons: ["source_transfer"] }] }).budgets[0]).toMatchObject({ remainingMinor: null, partial: true });
});

it("builds exact scoped evidence, excluding pending and transfers and retaining unknown balances", () => {
  expect(buildReviewEvidence(
    [{ id: "a", name: "Checking", currency_code: "EUR" }, { id: "b", name: "Savings", currency_code: "EUR" }],
    [{ account_id: "a", amount_minor: "9007199254740993", currency_code: "EUR", as_of: "2026-09-26T00:00:00Z", provenance: "manual" }],
    [
      { amount_minor: "10000", currency_code: "EUR", status: "posted", kind: "ordinary" },
      { amount_minor: "-4000", currency_code: "EUR", status: "posted", kind: "ordinary" },
      { amount_minor: "1000", currency_code: "EUR", status: "posted", kind: "refund" },
      { amount_minor: "-9000", currency_code: "EUR", status: "posted", kind: "transfer" },
      { amount_minor: "-2000", currency_code: "EUR", status: "pending", kind: "ordinary" },
      { amount_minor: "300", currency_code: "USD", status: "posted", kind: "ordinary" },
    ],
    "2026-07-01", "2026-09-26",
    { asOf: "2026-09-26T12:00:00Z", ledger: [] },
  )).toMatchObject({
    period: { from: "2026-07-01", to: "2026-09-26" },
    accounts: [
      { id: "a", name: "Checking", currencyCode: "EUR", balanceMinor: "9007199254740993", asOf: "2026-09-26T00:00:00Z", provenance: "manual" },
      { id: "b", name: "Savings", currencyCode: "EUR", balanceMinor: null, asOf: null, provenance: null },
    ],
    cashflow: {
      EUR: { incomeMinor: "10000", spendingMinor: "3000", netMinor: "7000" },
      USD: { incomeMinor: "300", spendingMinor: "0", netMinor: "300" },
    },
    netWorth: { EUR: null },
  });
});

it("separates dated savings, virtual reservations and budget pressure with exact source-linked evidence", () => {
  const report = buildPlanningReview({ today: "2026-10-02", goals: [{ id: "g", name: "Reserve", currency_code: "EUR", target_minor: "9007199254740993", recorded_saved_minor: "3000", saved_as_of: "2026-10-01", planned_monthly_minor: "1000", contribution_starts_on: "2026-10-31", target_date: "2026-12-31", status: "active" }], allocations: [{ goal_id: "g", amount_minor: "2500" }], budgets: [{ id: "b", category_id: "c", currency_code: "EUR", limit_minor: "1000", enabled: true }], transactions: [{ id: "t", posted_on: "2026-10-01", amount_minor: "-1200", currency_code: "EUR", status: "posted", kind: "ordinary", category_id: "c", merchant_id: null }], categories: [{ id: "c", name: "Food" }] });
  expect(report.goals[0]).toMatchObject({ recordedSavedMinor: "3000", savedAsOf: "2026-10-01", reservedMinor: "2500", remainingMinor: "9007199254737993", completionDate: null, link: "/plan" });
  expect(report.budgets[0]).toMatchObject({ spentMinor: "1200", remainingMinor: "-200", overLimit: true, partial: false });
  const future = buildPlanningReview({ today: "2026-10-02", goals: [{ id: "future", name: "Future", currency_code: "EUR", target_minor: "10000", recorded_saved_minor: "5000", saved_as_of: "2026-10-03", planned_monthly_minor: "1000", contribution_starts_on: "2026-10-31", target_date: null, status: "active" }], allocations: [], budgets: [], transactions: [], categories: [] });
  expect(future.goals[0]).toMatchObject({ recordedSavedMinor: null, remainingMinor: null, completionDate: null });
});

it("labels historical evidence stale instead of presenting it as current net worth", () => {
  const evidence = buildReviewEvidence([{ id: "a", name: "Cash", currency_code: "EUR" }],
    [{ account_id: "a", amount_minor: "10000", currency_code: "EUR", as_of: "2026-09-01T00:00:00Z", provenance: "manual" }],
    [], "2026-07-01", "2026-10-01", { asOf: "2026-10-01T12:00:00Z", ledger: [] });
  expect(evidence.accounts[0]).toMatchObject({ balanceMinor: null, snapshotBalanceMinor: "10000", balanceStatus: "stale" });
  expect(evidence.netWorth).toEqual({ EUR: null });
});

it("keeps unresolved classifications visible as partial review evidence", () => {
  expect(buildReviewEvidence([], [], [{ amount_minor: "50000", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: ["source_transfer"] }],
    "2026-09-01", "2026-09-30").cashflow.EUR).toEqual({ incomeMinor: "0", spendingMinor: "0", netMinor: "0", partial: true, excludedReviewRows: 1 });
});

it("compares equal calendar periods and grouped source evidence without counting uncertain, pending or internal movements", () => {
  const row = { id: "expense", parent_transaction_id: "parent", posted_on: "2026-09-30", amount_minor: "-9007199254740993", currency_code: "EUR", status: "posted", kind: "ordinary", category_id: "food", merchant_id: "shop", review_reasons: [] };
  const report = buildReviewInvestigation([row, { ...row, id: "refund", amount_minor: "993", kind: "refund" }, { ...row, id: "previous", posted_on: "2026-08-31", amount_minor: "-1000" }, { ...row, id: "uncertain", amount_minor: "-50000", review_reasons: ["source_transfer"] }, { ...row, id: "pending", status: "pending", currency_code: "USD" }], { from: "2026-09-01", to: "2026-09-30" }, [{ id: "food", name: "Food" }], [{ id: "shop", name: "Shop" }]);
  expect(report.comparisonPeriod).toEqual({ from: "2026-08-02", to: "2026-08-31" });
  expect(report.categories).toContainEqual(expect.objectContaining({ name: "Food", currency: "EUR", spendingMinor: "9007199254740000", previousSpendingMinor: "1000", changeMinor: "9007199254739000", sourceLinks: ["/money/transactions?transaction=parent"] }));
  expect(report.classificationReview).toMatchObject({ excludedRows: 1, link: "/import" });
  expect(report.merchants[0]).toMatchObject({ name: "Shop", spendingMinor: "9007199254740000" });
});

it("attributes a linked refund to the original purchase category in its own posting period", () => {
  const report = buildReviewInvestigation([{ id: "refund", posted_on: "2026-10-01", amount_minor: "500", currency_code: "EUR", status: "posted", kind: "refund", category_id: "other", merchant_id: null, refund_of_id: "purchase", refund_category_id: "food" }], { from: "2026-10-01", to: "2026-10-02" }, [{ id: "food", name: "Food" }], []);
  expect(report.categories[0]).toMatchObject({ id: "food", spendingMinor: "-500" });
});

it("combines current standalone wealth with account totals once and keeps historical or foreign currency evidence unknown", () => {
  const item = { id: "asset", name: "Asset", amount_minor: "5000", currency_code: "EUR", as_of: "2026-10-02", linked_account_id: null };
  expect(reviewNetWorth({ EUR: "10000", USD: null }, [item, { ...item, id: "linked", linked_account_id: "account" }], "2026-10-02")).toEqual({ EUR: "15000", USD: null });
  expect(reviewNetWorth({ EUR: "10000" }, [{ ...item, as_of: "2026-10-01" }], "2026-10-02")).toEqual({ EUR: null });
});
