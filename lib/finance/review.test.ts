import { expect, it } from "vitest";
import { buildReviewEvidence } from "./review";

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
  )).toEqual({
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
