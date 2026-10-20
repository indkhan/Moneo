import { expect, it } from "vitest";
import { toolResultReceipt } from "./tool-evidence";
import { buildPlanningReview, buildReviewEvidence, reviewNetWorth } from "./review";
import { resolveBalances } from "./balances";
import { wealthEvidence } from "./wealth";
const context = { workspaceId: "00000000-0000-4000-8000-000000000001", fetchedAt: "2026-10-01T00:00:00Z", timezone: "UTC" };
it.each(["manual", "manual reviewed"])("discloses %s provenance when publishing only a derived booked balance", provenance => {
  const accounts = [{ id: "cash", name: "Cash", currency_code: "EUR" }];
  const snapshots = [{ account_id: "cash", amount_minor: "500", currency_code: "EUR", as_of: context.fetchedAt, provenance }];
  const review = buildReviewEvidence(accounts, snapshots, [], "2026-07-04", "2026-10-01", { asOf: context.fetchedAt, ledger: [], timeZone: "UTC" });
  const direct = resolveBalances(accounts, snapshots, [], context.fetchedAt, "UTC");
  for (const [name, result, ids] of [
    ["accounts_getBalances", direct, ["0.balance.amount_minor", "0.balance.snapshot_amount_minor"]],
    ["reviews_investigate", { ...review, accountBalanceTotals: review.netWorth }, ["accounts.0.balanceMinor", "accounts.0.snapshotBalanceMinor", "netWorth.EUR", "accountBalanceTotals.EUR"]],
  ] as const) {
    const receipt = toolResultReceipt(name, {}, result, context, ["accounts"]);
    for (const id of ids) {
      const metric = receipt.metrics.find(metric => metric.id === id)!;
      expect(metric).toMatchObject({ valueMinor: "500", period: { from: "2026-10-01", to: "2026-10-01" }, qualifiers: expect.arrayContaining(["manual_evidence", "dated_snapshot"]) });
    }
  }
});
it("requires aggregate net worth to disclose its own currency's included manual valuation", () => {
  const wealth = [{ id: "manual", name: "Asset", amount_minor: "1000", currency_code: "EUR", as_of: "2026-10-01", linked_account_id: null }];
  const result = { netWorth: reviewNetWorth({ EUR: "500", USD: "200" }, wealth, "2026-10-01"), accountBalanceTotals: { EUR: "500" }, planning: { wealth: wealthEvidence(wealth, "2026-10-01") } };
  const receipt = toolResultReceipt("reviews_investigate", {}, result, context, ["accounts", "planning"]);
  const metric = receipt.metrics.find(metric => metric.id === "netWorth.EUR")!;
  expect(metric.qualifiers).toContain("manual_evidence");
  expect(receipt.metrics.find(metric => metric.id === "netWorth.USD")?.qualifiers).not.toContain("manual_evidence");
  expect(receipt.metrics.find(metric => metric.id === "accountBalanceTotals.EUR")?.qualifiers).not.toContain("manual_evidence");
});
it("propagates manual booked-balance provenance into account and net-worth aggregates", () => {
  const receipt = toolResultReceipt("reviews_investigate", {}, { netWorth: { EUR: "500" }, accountBalanceTotals: { EUR: "500" }, accounts: [{ currencyCode: "EUR", balanceMinor: "500", provenance: "manual", asOf: "2026-10-01" }] }, context, ["accounts"]);
  for (const id of ["netWorth.EUR", "accountBalanceTotals.EUR"]) expect(receipt.metrics.find(metric => metric.id === id)?.qualifiers).toContain("manual_evidence");
});
it("discloses the real goal remainder's manual savings date and target assumption", () => {
  const planning = buildPlanningReview({ today: "2026-10-01", goals: [{ id: "goal", name: "Goal", currency_code: "EUR", target_minor: "10000", recorded_saved_minor: "2500", saved_as_of: "2026-01-01", planned_monthly_minor: "0", contribution_starts_on: null, target_date: null, status: "active" }], allocations: [], budgets: [], transactions: [], categories: [] });
  const receipt = toolResultReceipt("reviews_investigate", {}, { period: { from: "2026-07-01", to: "2026-09-30" }, planning }, context, ["planning"]);
  const remaining = receipt.metrics.find(metric => metric.id.endsWith("remainingMinor"))!;
  expect(remaining).toMatchObject({ valueMinor: "7500", period: { from: "2026-01-01", to: "2026-01-01" }, qualifiers: expect.arrayContaining(["manual_evidence", "dated_snapshot", "assumption"]) });
  expect(remaining.calculation).toContain("savedAsOf");
  const target = receipt.metrics.find(metric => metric.id.endsWith("targetMinor"))!;
  expect(target.qualifiers).toContain("assumption");
  expect(target.qualifiers).not.toContain("manual_evidence");
  expect(target.period).toEqual({ from: "2026-07-01", to: "2026-09-30" });
});
it("retains every query input/result and derives only exact typed monetary facts", () => {
  const result = { from: "2026-09-01", to: "2026-09-30", currencyCode: "EUR", spendingMinor: "9007199254740993", sourceCoverage: { financialCompleteness: "unknown" }, evidence: { partial: true, excludedReviewRows: 2 } };
  const receipt = toolResultReceipt("analytics_cashflow", { from: result.from, to: result.to, currencyCode: "EUR" }, result, context, ["transactions"]);
  expect(receipt.query.result).toEqual(result);
  expect(receipt.query.input).toEqual({ from: result.from, to: result.to, currencyCode: "EUR" });
  expect(receipt.metrics).toContainEqual(expect.objectContaining({ label: "Spending", valueMinor: result.spendingMinor, period: { from: result.from, to: result.to }, qualifiers: ["partial_classification"] }));
  expect(receipt.sources[0].record).toEqual(result);
});
it("preserves unresolved source posting uncertainty without calling its amount spending", () => {
  const receipt = toolResultReceipt("transactions_search", { query: "transfer" }, [{ id: "00000000-0000-4000-8000-000000000002", posted_on: "2026-09-01", amount_minor: "-25", currency_code: "EUR", kind: "ordinary", classificationStatus: "unresolved", review_reasons: ["source_transfer"], effectiveRows: [] }], context, ["transactions"]);
  expect(receipt.metrics[0]).toMatchObject({ label: "Recorded source posting", qualifiers: ["unresolved_included", "source_posting"] });
  expect(receipt.metrics[0].label).not.toBe("Spending");
});
it("keeps an ambiguous JPY snapshot separate from the EUR account currency", () => {
  const receipt = toolResultReceipt("accounts_getBalances", {}, [{ currency_code: "EUR", balance: { amount_minor: null, snapshot_amount_minor: "100", snapshot_currency_code: "JPY", status: "ambiguous", as_of: "2026-09-01T00:00:00Z", warnings: ["Snapshot currency differs from account currency"] } }], context, ["accounts"]);
  const snapshot = receipt.metrics.find(metric => metric.label === "Dated recorded balance")!;
  expect(snapshot).toMatchObject({ currency: "JPY", valueMinor: "100", qualifiers: expect.arrayContaining(["ambiguous_evidence", "dated_snapshot"]) });
  expect(snapshot.qualifiers).not.toContain("manual_evidence");
});
it("uses actual balance clocks, workspace calendar dates and manual wealth dates rather than review ranges", () => {
  const review = toolResultReceipt("reviews_investigate", {}, { period: { from: "2026-07-01", to: "2026-09-30" }, accounts: [{ currencyCode: "EUR", balanceMinor: "10", snapshotBalanceMinor: "20", snapshotCurrencyCode: "EUR", evaluatedAt: "2026-10-01T22:30:00Z", asOf: "2026-09-01T22:30:00Z" }], planning: { wealth: { included: [{ currencyCode: "EUR", amountMinor: "30", asOf: "2026-08-05", provenance: "manual valuation" }] }, goals: [{ currency: "EUR", recordedSavedMinor: "40", savedAsOf: "2026-08-06" }] } }, { ...context, timezone: "Europe/Berlin" }, ["accounts", "transactions", "planning"]);
  expect(review.metrics.find(metric => metric.label === "Booked balance")?.period).toEqual({ from: "2026-10-02", to: "2026-10-02" });
  expect(review.metrics.find(metric => metric.label === "Dated recorded balance")?.period).toEqual({ from: "2026-09-02", to: "2026-09-02" });
  expect(review.metrics.find(metric => metric.label === "Dated manual wealth value")).toMatchObject({ period: { from: "2026-08-05", to: "2026-08-05" }, qualifiers: expect.arrayContaining(["manual_evidence", "dated_snapshot"]) });
  expect(review.metrics.find(metric => metric.label === "Dated recorded savings")?.qualifiers).not.toContain("assumption");
  const snake = toolResultReceipt("accounts_getBalances", {}, [{ currency_code: "EUR", balance: { amount_minor: "10", evaluated_at: "2026-10-01T22:30:00Z", snapshot_amount_minor: "20", snapshot_currency_code: "EUR", as_of: "2026-09-01" } }], { ...context, timezone: "Europe/Berlin" }, ["accounts"]);
  expect(snake.metrics.find(metric => metric.label === "Booked balance")?.period).toEqual({ from: "2026-10-02", to: "2026-10-02" });
  expect(snake.metrics.find(metric => metric.label === "Dated recorded balance")?.period).toEqual({ from: "2026-09-01", to: "2026-09-01" });
});
it("labels effective components separately from their canonical parent", () => {
  const result = [{ id: "parent", amountBasis: "canonical_parent", amount_minor: "-100", currency_code: "EUR", posted_on: "2026-10-07", effectiveRows: [{ id: "component", parent_transaction_id: "parent", amount_minor: "-100", currency_code: "EUR" }] }, { id: "other", amountBasis: "canonical_parent", amount_minor: "-50", currency_code: "EUR", posted_on: "2026-10-07" }];
  const receipt = toolResultReceipt("transactions_search", {}, result, context, ["transactions"]);
  expect(receipt.metrics[1].label).toContain("component");
});
it("distinguishes effective detail records from their canonical parent", () => {
  const receipt = toolResultReceipt("finance_detail", {}, { transaction: { id: "parent", amount_minor: "-100", currency_code: "EUR", posted_on: "2026-10-07" }, effectiveRows: [{ id: "component", parentId: "parent", amountMinor: "-100", currency: "EUR", date: "2026-10-07" }] }, context, ["transactions"]);
  expect(receipt.metrics[1].label).toContain("component");
  expect(receipt.metrics[1].aggregation?.parents).toEqual(["parent"]);
});
it("retains unavailable inputs as receipt limitations", () => {
  const receipt = toolResultReceipt("forecast_evaluate", {}, { status: "unavailable", missingInputs: ["Current booked balance for Checking is unavailable", "Current booked balance for Checking is unavailable"] }, context, ["accounts", "planning"]);
  expect(receipt.limitations?.map(limit => limit.message)).toEqual(["Current booked balance for Checking is unavailable"]);
  const cashflow = toolResultReceipt("analytics_cashflow", {}, { unavailable: "Some transactions require currency conversion" }, context, ["transactions"]);
  expect(cashflow.limitations?.[0].message).toBe("Some transactions require currency conversion");
});
it("retains forward review forecast horizons and limiting dates", () => {
  const receipt = toolResultReceipt("reviews_investigate", {}, { period: { from: "2026-07-10", to: "2026-10-07" }, planning: { forecast: { evaluatedOn: "2026-10-07", horizonDays: 90, currency: "EUR", available: { status: "available", amountMinor: "100", limitingDate: "2026-11-01" } } } }, context, ["accounts", "transactions", "planning"]);
  expect(receipt.metrics[0]).toMatchObject({ period: { from: "2026-10-07", to: "2027-01-04" }, qualifiers: expect.arrayContaining(["assumption"]) });
  expect(receipt.metrics[0].calculation).toContain("2026-11-01");
  expect(receipt.metrics[0].label).toBe("Conditional aggregate headroom");
});
it("keeps direct review cashflow and typed budget classification exclusions on zero-valued measures", () => {
  const receipt = toolResultReceipt("reviews_investigate", {}, { period: { from: "2026-09-01", to: "2026-09-30" }, cashflow: { EUR: { spendingMinor: "0", incomeMinor: "0", netMinor: "0", excludedReviewRows: 1, partial: true } }, planning: { budgets: [{ currency: "EUR", month: "2026-09", spentMinor: "0", partial: true, classificationPartial: true, limitation: "Current-month financial classification needs review" }] } }, context, ["accounts", "transactions", "planning"]);
  expect(receipt.metrics).toHaveLength(4);
  for (const metric of receipt.metrics) expect(metric.qualifiers).toContain("partial_classification");
  expect(receipt.metrics.find(metric => metric.label === "Booked budget spending")?.qualifiers).toContain("partial_budget");
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
