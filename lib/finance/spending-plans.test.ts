import { describe, expect, it } from "vitest";
import { nextMonthStart, spendingForCategory, type SpendingPlanTransaction } from "./spending-plans";

const MONTH = "2026-09";
const CATEGORY = "groceries";
const EUR = "EUR";

it("provides a full date for the next month, including year rollover", () => {
  expect(nextMonthStart("2026-09")).toBe("2026-10-01");
  expect(nextMonthStart("2026-12")).toBe("2027-01-01");
});

function row(partial: Partial<SpendingPlanTransaction> & { amountMinor: bigint }): SpendingPlanTransaction {
  return {
    currencyCode: EUR,
    status: "posted",
    kind: "ordinary",
    categoryId: CATEGORY,
    postedOn: `${MONTH}-10`,
    ...partial,
  };
}

describe("monthly category spending", () => {
  it("nets posted ordinary expenses with linked refunds and excludes transfers, pending, income and other months", () => {
    const transactions = [
      row({ amountMinor: -4000n }),
      row({ amountMinor: -1500n, categoryId: "other" }),
      row({ amountMinor: 10000n }), // income is not spending
      row({ amountMinor: -99999n, status: "pending" }),
      row({ amountMinor: -99999n, kind: "transfer" }),
      row({ amountMinor: -99999n, postedOn: "2026-08-31" }),
      row({ amountMinor: -99999n, currencyCode: "USD" }),
      // Linked refund posted this month against a Groceries original.
      row({ amountMinor: 1000n, kind: "refund", categoryId: null, refundOfCategoryId: CATEGORY, refundOfCurrencyCode: EUR }),
      // Refund linked to another category must not reduce this one.
      row({ amountMinor: 5000n, kind: "refund", categoryId: null, refundOfCategoryId: "other", refundOfCurrencyCode: EUR }),
    ];
    expect(spendingForCategory(transactions, CATEGORY, EUR, MONTH)).toBe(3000n);
  });

  it("keeps large minor-unit totals exact without floats", () => {
    const transactions = [row({ amountMinor: -9007199254740993n }), row({ amountMinor: 7n, kind: "refund", categoryId: null, refundOfCategoryId: CATEGORY, refundOfCurrencyCode: EUR })];
    expect(spendingForCategory(transactions, CATEGORY, EUR, MONTH)).toBe(9007199254740986n);
  });
});
