import { expect, it } from "vitest";
import { holdingValue, debtPayments, wealthEvidence, buildDebtForecast, type WealthItem } from "./wealth";

it("values fractional holdings from exact decimal strings with minor-unit rounding", () => {
  expect(holdingValue("0.125", "80.04", "EUR")).toBe(1001n);
  expect(holdingValue("90071992547409.93", "1", "EUR")).toBe(9007199254740993n);
  expect(holdingValue("0.5", "3", "JPY")).toBe(2n);
  for (const quantity of ["1e3", "-1", "0", "1,000"]) expect(() => holdingValue(quantity, "1", "EUR")).toThrow();
  expect(() => holdingValue("92233720368547758.08", "1", "EUR")).toThrow();
});

it("reuses explicit repayment provenance and consumes an already-held payment once", () => {
  const debt: WealthItem = { id: "debt", name: "Loan", kind: "debt", amount_minor: "-10000", currency_code: "EUR", as_of: "2026-10-02", linked_account_id: null,
    quantity_text: null, unit_price_text: null, cost_basis_minor: null, payment_account_id: "cash", annual_rate_text: "0", monthly_payment_minor: "6000", next_payment_on: "2026-10-02",
    payment_assumption_id: "repayment", payment_transaction_id: "hold", version: 1, removed_at: null };
  const accounts = [{ id: "cash", type: "checking", currency_code: "EUR" }];
  const ledger = [{ id: "hold", account_id: "cash", amount_minor: "-6000", currency_code: "EUR", posted_on: "2026-10-02", status: "pending" }];
  const assumptions = [{ id: "repayment", account_id: "cash", amount_minor: "-6000", currency_code: "EUR", cadence: "monthly", starts_on: "2026-10-02", ends_on: null }];
  expect(buildDebtForecast([debt], [{ ...accounts[0], archived_at: "2026-10-02T12:00:00Z" }], ledger, assumptions, "2026-10-02", 60)).toEqual({ events: [], excludedAssumptionIds: [], missingInputs: ["debt:debt:liquid repayment account"] });
  expect(buildDebtForecast([debt], accounts, ledger, assumptions, "2026-10-02", 60)).toMatchObject({
    excludedAssumptionIds: ["repayment"], missingInputs: [], events: [{ date: "2026-11-02", accountId: "cash", amountMinor: -4000n }],
  });
  expect(buildDebtForecast([debt], accounts, ledger, [{ ...assumptions[0], amount_minor: "-5000" }], "2026-10-02", 60).missingInputs).toContain("debt:debt:repayment association changed");
  expect(buildDebtForecast([debt], accounts, [{ ...ledger[0], status: "posted" }], assumptions, "2026-10-02", 60).excludedAssumptionIds).toEqual([]);
  expect(buildDebtForecast([{ ...debt, payment_assumption_id: null, payment_transaction_id: null }], accounts, ledger, [], "2026-10-02", 60).missingInputs).toContain("debt:debt:pending repayment needs association");
  expect(buildDebtForecast([debt, { ...debt, id: "second" }], accounts, ledger, assumptions, "2026-10-02", 60).missingInputs).toContain("debt:second:duplicate repayment provenance");
});

it("caps monthly debt cash obligations at payoff and carries exact interest assumptions", () => {
  expect(debtPayments({ principalMinor: -10000n, annualRate: "12", monthlyPaymentMinor: 6000n, nextPaymentOn: "2026-01-31" }, "2026-01-01", 90)).toEqual([
    { date: "2026-01-31", paymentMinor: 6000n, interestMinor: 100n, principalMinor: 5900n, remainingMinor: 4100n },
    { date: "2026-02-28", paymentMinor: 4141n, interestMinor: 41n, principalMinor: 4100n, remainingMinor: 0n },
  ]);
  expect(debtPayments({ principalMinor: -10000n, annualRate: "0", monthlyPaymentMinor: 6000n, nextPaymentOn: "2026-01-31" }, "2026-01-01", 90)[1].paymentMinor).toBe(4000n);
});

it("keeps linked accounts out of additional net worth and flags historical evidence", () => {
  const base = { id: "asset", name: "Asset", amount_minor: "10000", currency_code: "EUR", as_of: "2026-10-02", linked_account_id: null };
  expect(wealthEvidence([base, { ...base, id: "holding", linked_account_id: "investment" }, { ...base, id: "old", as_of: "2026-10-01" }], "2026-10-02"))
    .toMatchObject({ included: [{ id: "asset", amountMinor: 10000n }], excludedLinked: ["holding"], missingInputs: ["valuation:old:historical"] });
});

it("does not use a canceled pending authorization to suppress a debt payment", () => {
  const debt: WealthItem = { id: "debt", name: "Loan", kind: "debt", amount_minor: "-10000", currency_code: "EUR", as_of: "2026-10-02", linked_account_id: null,
    quantity_text: null, unit_price_text: null, cost_basis_minor: null, payment_account_id: "cash", annual_rate_text: "0", monthly_payment_minor: "6000", next_payment_on: "2026-10-02",
    payment_assumption_id: null, payment_transaction_id: "hold", version: 1, removed_at: null };
  const ledger = [{ id: "hold", account_id: "cash", amount_minor: "-6000", currency_code: "EUR", posted_on: "2026-10-02", status: "pending", pending_released_minor: "6000" }];
  expect(buildDebtForecast([debt], [{ id: "cash", type: "checking", currency_code: "EUR" }], ledger, [], "2026-10-02", 60).missingInputs).toContain("debt:debt:pending repayment association changed");
  expect(buildDebtForecast([{ ...debt, payment_transaction_id: null }], [{ id: "cash", type: "checking", currency_code: "EUR" }], [{ ...ledger[0], pending_released_minor: "500" }], [], "2026-10-02", 60).missingInputs).toContain("debt:debt:pending repayment needs association");
});
