import { expect, it } from "vitest";
import { summarizeSpending, type SpendingRow } from "@/lib/finance/dashboard-spending";

const row = (id: string, posted_on: string, amount_minor: string, extra: Partial<SpendingRow> = {}): SpendingRow => ({
  id, account_id: "a", posted_on, amount_minor, currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [], category_id: "food", merchant_id: "shop", ...extra });

it("compares month-to-date with the same days last month and ranks categories and merchants from reported totals", () => {
  const summary = summarizeSpending([
    row("1", "2026-03-31", "-500"),
    row("2", "2026-02-28", "-300"),
    row("3", "2026-02-27", "-100", { category_id: null, merchant_id: null }),
    row("4", "2026-03-02", "-200", { category_id: "rent", merchant_id: "landlord" }),
    row("5", "2026-03-03", "150", { kind: "refund" }),
    row("6", "2026-03-04", "-999", { status: "pending" }),
    row("7", "2026-03-05", "-999", { kind: "transfer" }),
    row("8", "2026-03-06", "-50", { currency_code: "USD", merchant_id: "abroad" }),
    row("9", "2025-10-01", "-70"),
  ], [], "EUR", "2026-03-31");
  expect(summary.trend.map(month => month.month)).toEqual(["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"]);
  expect(summary.trend.map(month => month.spendingMinor)).toEqual([70n, 0n, 0n, 0n, 400n, 550n]);
  expect(summary.thisMonth).toMatchObject({ spendingMinor: 550n, partial: true });
  expect(summary.lastMonthToDate).toMatchObject({ from: "2026-02-01", to: "2026-02-28", spendingMinor: 400n, partial: false });
  expect(summary.categories.map(group => [group.id, group.spendingMinor])).toEqual([["food", 350n], ["rent", 200n]]);
  expect(summary.merchants.map(group => [group.id, group.spendingMinor])).toEqual([["shop", 350n], ["landlord", 200n]]);
});

it("totals income per month and ranks where it came from, leaving transfers out", () => {
  const summary = summarizeSpending([
    row("1", "2026-03-01", "300000", { category_id: "salary", merchant_id: "employer" }),
    row("2", "2026-03-10", "5000", { category_id: "interest", merchant_id: "bank" }),
    row("3", "2026-03-11", "90000", { kind: "transfer", category_id: null, merchant_id: null }),
    row("4", "2026-03-12", "-2000"),
    row("5", "2026-02-01", "300000", { category_id: "salary", merchant_id: "employer" }),
  ], [], "EUR", "2026-03-31");
  expect(summary.trend.slice(-2).map(month => [month.incomeMinor, month.spendingMinor])).toEqual([[300000n, 0n], [305000n, 2000n]]);
  const march = summary.months[5];
  expect(march.incomeCategories.map(group => [group.id, group.incomeMinor])).toEqual([["salary", 300000n], ["interest", 5000n]]);
  expect(march.incomeMerchants.map(group => group.id)).toEqual(["employer", "bank"]);
  expect(march.categories.map(group => group.id)).toEqual(["food"]);
});

it("gives every day in the window its in and out totals", () => {
  const summary = summarizeSpending([
    row("1", "2026-03-05", "-500"),
    row("2", "2026-03-05", "-200"),
    row("3", "2026-03-05", "1000", { category_id: "salary", merchant_id: "employer" }),
  ], [], "EUR", "2026-03-31");
  expect(summary.daily).toHaveLength(182);
  expect(summary.daily.at(0)?.date).toBe("2025-10-01");
  expect(summary.daily.at(-1)?.date).toBe("2026-03-31");
  expect(summary.daily.find(item => item.date === "2026-03-05")).toMatchObject({ month: "2026-03", incomeMinor: 1000n, spendingMinor: 700n });
});
