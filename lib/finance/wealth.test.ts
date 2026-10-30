import { expect, it } from "vitest";
import { holdingValue, debtPayments, wealthEvidence, buildDebtForecast, wealthOverview, type WealthItem } from "./wealth";

it("lists money lent and owed by person with totals per group and currency, leaving removed items out", () => {
  const item = (id: string, name: string, kind: WealthItem["kind"], amount_minor: string, removed_at: string | null = null) => ({ id, name, kind, amount_minor, currency_code: "EUR", as_of: "2026-09-22", removed_at });
  const overview = wealthOverview([item("a", "Lent to Bilal", "asset", "100000"), item("b", "Lent to Venjalin", "asset", "25000"), item("c", "Owed to Sam", "debt", "5000"),
    item("d", "Car", "asset", "800000"), item("e", "Lent to Old", "asset", "999", "2026-10-01")]);
  expect(overview.items.map(row => [row.group, row.person, row.amountFormatted])).toEqual([["lent", "Bilal", "EUR 1000.00"], ["lent", "Venjalin", "EUR 250.00"], ["borrowed", "Sam", "EUR 50.00"], ["asset", undefined, "EUR 8000.00"]]);
  expect(overview.totals).toEqual([{ group: "lent", currencyCode: "EUR", amountMinor: "125000", amountFormatted: "EUR 1250.00" },
    { group: "borrowed", currencyCode: "EUR", amountMinor: "5000", amountFormatted: "EUR 50.00" }, { group: "asset", currencyCode: "EUR", amountMinor: "800000", amountFormatted: "EUR 8000.00" }]);
});

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

it("keeps a loan to or from a person in current net worth from the day it was made", () => {
  const loan = { id: "loan", name: "Lent to Bilal", amount_minor: "100000", currency_code: "EUR", as_of: "2026-09-22", linked_account_id: null };
  expect(wealthEvidence([loan, { ...loan, id: "owed", name: "Owed to Sam", amount_minor: "-500" }], "2026-10-27"))
    .toMatchObject({ included: [{ id: "loan", amountMinor: 100000n }, { id: "owed", amountMinor: -500n }], missingInputs: [] });
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
