import { expect, it } from "vitest";
import { budgetProgress, type SpendingPlanTransaction } from "./spending-plans";
import { buildPlanningReview } from "./review";
import { buildSourceCoverage } from "./source-coverage";
const known: SpendingPlanTransaction = { amountMinor: -1000n, currencyCode: "EUR", status: "posted", kind: "ordinary", categoryId: "food", postedOn: "2026-10-01" };
const unknown = { ...known, amountMinor: -20000n, reviewReasons: ["source_type"] };

it("keeps accepted spending exact and gates a remainder for unresolved source overlap, including undo", () => {
  const scope = { from: "2026-10-01", to: "2026-10-31", currencyCode: "EUR" };
  for (const status of ["review", "matched", "review"]) {
    const sourceCoverage = buildSourceCoverage(scope, [], [{ id: "i", status: "completed", total_rows: 1 }],
      [{ import_id: "i", status, posted_on: "2026-10-01", currency_code: "EUR", account_id: "a" }]);
    expect(budgetProgress([known], "food", "EUR", "2026-10", 10000n, undefined, sourceCoverage)).toMatchObject({
      spentMinor: 1000n, remainingMinor: status === "matched" ? 9000n : null, overLimit: status === "matched" ? false : null });
    expect(buildPlanningReview({ today: "2026-10-07", goals: [], allocations: [], categories: [],
      budgets: [{ id: "b", category_id: "food", currency_code: "EUR", limit_minor: "10000", enabled: true }],
      budgetCoverage: { b: sourceCoverage }, transactions: [{ id: "t", amount_minor: "-1000", currency_code: "EUR", status: "posted", kind: "ordinary", posted_on: "2026-10-01", category_id: "food", merchant_id: null }] }).budgets[0]).toMatchObject({
      sourceCoverage, remainingMinor: status === "matched" ? "9000" : null, remainderBasis: "accepted_records" });
  }
});
function progress(rows: SpendingPlanTransaction[], rollover = false) {
  return budgetProgress(rows, "food", "EUR", "2026-10", 10000n, rollover ? { startsMonth: "2026-09", history: [{ effective_month: "2026-09-01", limit_minor: "10000", enabled: true, version: 1 }] } : undefined);
}
it.each(["ordinary", "transfer", "refund"])("withholds remaining and over-limit for unresolved %s and preserves the classified subtotal", kind => {
  expect(progress([known, { ...unknown, kind }])).toMatchObject({ spentMinor: 1000n, allowanceMinor: 10000n, remainingMinor: null, overLimit: null, partial: true });
});
it.each([
  [{ categoryId: null }, true], [{ categoryId: "other" }, false], [{ currencyCode: "USD" }, false],
  [{ status: "pending" }, false], [{ postedOn: "2026-09-01" }, false],
  [{ kind: "refund", categoryId: null, refundOfCategoryId: "other" }, false],
  [{ kind: "refund", categoryId: "other", refundOfCategoryId: "food" }, true],
  [{ kind: "refund", categoryId: "other", refundOfCategoryId: null }, true],
] as const)("scopes classification uncertainty %j", (patch, partial) => {
  expect(progress([known, { ...unknown, ...patch }])).toMatchObject({ partial, remainingMinor: partial ? null : 9000n });
});
it("uses posting-currency refunds, exact money and does not mutate evidence", () => {
  const rows = [known, { ...known, amountMinor: 400n, kind: "refund", categoryId: "other", refundOfCategoryId: "food", refundOfCurrencyCode: "USD" }];
  const before = structuredClone(rows);
  expect(progress(rows)).toMatchObject({ spentMinor: 600n, remainingMinor: 9400n });
  expect(budgetProgress([{ ...known, amountMinor: -9007199254740993n }], "food", "EUR", "2026-10", 9007199254740999n)).toMatchObject({ remainingMinor: 6n });
  expect(rows).toEqual(before);
});
it.each([false, true])("native domain and AI review agree after correction and undo (rollover %s)", rollover => {
  const old = { ...known, postedOn: "2026-09-01", amountMinor: -3000n };
  for (const rows of [[known, old, unknown], [known, old, { ...unknown, reviewReasons: [] }], [known, old, unknown]]) {
    const native = progress(rows, rollover);
    const ai = buildPlanningReview({ today: "2026-10-07", goals: [], allocations: [], categories: [], budgets: [{ id: "budget", category_id: "food", currency_code: "EUR", limit_minor: "10000", enabled: true, rollover, rollover_from: "2026-09-01" }], budgetHistory: [{ plan_id: "budget", effective_month: "2026-09-01", limit_minor: "10000", enabled: true, version: 1 }], transactions: rows.map((row, index) => ({ id: String(index), amount_minor: row.amountMinor.toString(), currency_code: row.currencyCode, status: row.status, kind: row.kind, category_id: row.categoryId, posted_on: row.postedOn, merchant_id: null, review_reasons: row.reviewReasons })) }).budgets[0];
    expect(ai).toMatchObject({ spentMinor: native.spentMinor.toString(), remainingMinor: native.remainingMinor?.toString() ?? null, overLimit: native.overLimit, partial: native.partial, limitation: native.limitation });
  }
});
it("historical uncertainty restores unknown carry on undo and ignores unrelated categories", () => {
  const old = { ...unknown, postedOn: "2026-09-01" };
  expect(progress([known, old], true)).toMatchObject({ carriedMinor: null, remainingMinor: null, partial: true });
  expect(progress([known, { ...old, reviewReasons: [] }], true)).toMatchObject({ carriedMinor: -10000n, remainingMinor: -1000n, overLimit: true });
  expect(progress([known, old], true)).toMatchObject({ carriedMinor: null, remainingMinor: null });
  expect(progress([known, { ...old, categoryId: "other" }], true)).toMatchObject({ carriedMinor: 10000n, remainingMinor: 19000n, partial: false });
});
