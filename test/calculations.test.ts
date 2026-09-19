// E03-S02 calculation goldens: exact deterministic cash/spend/income with
// transfers, fees, credit repayments, refunds. Pure functions, no DB needed
// for core math; independent expectations hand-calculated.

import { describe, expect, it } from "vitest";
import {
  calculateAccountTotals,
  calculateWorkspaceTotals,
  classifyLeg,
  filterOwnedLegs,
  type ClassifiedLeg,
  type TransactionLeg,
} from "../apps/web/src/calculations/cash.ts";

describe("e03-s02 cash/spend/income calculations", () => {
  const ownedAccounts = new Map<string, { currency: string }>([
    ["acc-a", { currency: "EUR" }],
    ["acc-b", { currency: "USD" }],
    ["acc-c", { currency: "JPY" }],
  ]);
  const ownedAccountIds = new Set(["acc-a", "acc-b", "acc-c"]);

  function makeLeg(overrides: Partial<TransactionLeg> = {}): TransactionLeg {
    return {
      accountId: "acc-a",
      amountMinor: 10000n,
      currency: "EUR",
      direction: "OUTFLOW",
      effectiveDate: "2024-01-15",
      description: "Test",
      source: "manual",
      ...overrides,
    };
  }

  it("classifies regular income and spend", () => {
    const incomeLeg = makeLeg({ accountId: "acc-a", direction: "INFLOW", amountMinor: 50000n });
    const spendLeg = makeLeg({ accountId: "acc-a", direction: "OUTFLOW", amountMinor: 2500n });

    const classifiedIncome = classifyLeg(incomeLeg, ownedAccountIds);
    const classifiedSpend = classifyLeg(spendLeg, ownedAccountIds);

    expect(classifiedIncome.classification).toBe("income");
    expect(classifiedIncome.signedAmountMinor).toBe(50000n);
    expect(classifiedSpend.classification).toBe("spend");
    expect(classifiedSpend.signedAmountMinor).toBe(-2500n);
  });

  it("classifies transfer principal when both accounts owned", () => {
    const transferOut = makeLeg({ accountId: "acc-a", direction: "OUTFLOW", amountMinor: 10000n, counterpartyAccountId: "acc-b" });
    const transferIn = makeLeg({ accountId: "acc-b", direction: "INFLOW", amountMinor: 10000n, counterpartyAccountId: "acc-a" });

    const classifiedOut = classifyLeg(transferOut, ownedAccountIds);
    const classifiedIn = classifyLeg(transferIn, ownedAccountIds);

    expect(classifiedOut.classification).toBe("transfer_principal");
    expect(classifiedOut.signedAmountMinor).toBe(0n);
    expect(classifiedIn.classification).toBe("transfer_principal");
    expect(classifiedIn.signedAmountMinor).toBe(0n);
  });

  it("classifies transfer fee as expense", () => {
    const feeLeg = makeLeg({ accountId: "acc-a", direction: "OUTFLOW", amountMinor: 500n, isFee: true, counterpartyAccountId: "acc-b" });
    const classified = classifyLeg(feeLeg, ownedAccountIds);

    expect(classified.classification).toBe("transfer_fee");
    expect(classified.signedAmountMinor).toBe(-500n);
  });

  it("classifies refund as negative spend", () => {
    const refundLeg = makeLeg({ accountId: "acc-a", direction: "INFLOW", amountMinor: 1000n, isRefund: true });
    const classified = classifyLeg(refundLeg, ownedAccountIds);

    expect(classified.classification).toBe("refund");
    // Refund of spend (original was OUTFLOW) → INFLOW reduces spend
    expect(classified.signedAmountMinor).toBe(-1000n);
  });

  it("classifies credit repayment as transfer when both accounts owned", () => {
    const repaymentLeg = makeLeg({ accountId: "acc-a", direction: "OUTFLOW", amountMinor: 50000n, isCreditRepayment: true, counterpartyAccountId: "acc-c" });
    const classified = classifyLeg(repaymentLeg, ownedAccountIds);

    expect(classified.classification).toBe("credit_repayment");
    expect(classified.signedAmountMinor).toBe(0n);
  });

  it("filters legs to owned accounts only", () => {
    const legs: TransactionLeg[] = [
      makeLeg({ accountId: "acc-a", amountMinor: 1000n }),
      makeLeg({ accountId: "acc-x", amountMinor: 2000n }), // not owned
      makeLeg({ accountId: "acc-b", amountMinor: 3000n }),
    ];
    const filtered = filterOwnedLegs(legs, ownedAccountIds);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(l => l.accountId)).toEqual(["acc-a", "acc-b"]);
  });

  it("calculates workspace totals with mixed transaction types", () => {
    const legs: TransactionLeg[] = [
      // Income: salary
      makeLeg({ accountId: "acc-a", direction: "INFLOW", amountMinor: 100000n, description: "Salary" }),
      // Spend: groceries
      makeLeg({ accountId: "acc-a", direction: "OUTFLOW", amountMinor: 5000n, description: "Groceries" }),
      // Transfer A->B (both owned)
      makeLeg({ accountId: "acc-a", direction: "OUTFLOW", amountMinor: 10000n, counterpartyAccountId: "acc-b", description: "Transfer to B" }),
      makeLeg({ accountId: "acc-b", direction: "INFLOW", amountMinor: 10000n, counterpartyAccountId: "acc-a", description: "Transfer from A" }),
      // Fee on transfer
      makeLeg({ accountId: "acc-a", direction: "OUTFLOW", amountMinor: 200n, isFee: true, counterpartyAccountId: "acc-b", description: "Transfer fee" }),
      // Refund
      makeLeg({ accountId: "acc-a", direction: "INFLOW", amountMinor: 1000n, isRefund: true, description: "Refund" }),
      // Credit repayment C->A
      makeLeg({ accountId: "acc-c", direction: "OUTFLOW", amountMinor: 20000n, isCreditRepayment: true, counterpartyAccountId: "acc-a", description: "Credit repayment" }),
      makeLeg({ accountId: "acc-a", direction: "INFLOW", amountMinor: 20000n, isCreditRepayment: true, counterpartyAccountId: "acc-c", description: "Credit repayment" }),
    ];

    const classified = legs.map(l => classifyLeg(l, ownedAccountIds));
    const totals = calculateWorkspaceTotals(classified, ownedAccounts);

    // Income: 100000 (salary) — credit repayment in is not income
    expect(totals.incomeMinor).toBe("100000");
    // Spend: 5000 (groceries) + 200 (fee) - 1000 (refund reduces spend) = 4200
    expect(totals.spendMinor).toBe("4200");
    // Cash: 100000 - 4200 = 95800
    expect(totals.cashMinor).toBe("95800");
    // Transfer principal: 10000 (A out) + 10000 (B in) = 20000
    expect(totals.transferPrincipalMinor).toBe("20000");
    // Transfer fee: 200
    expect(totals.transferFeeMinor).toBe("200");
    // Refund: 1000
    expect(totals.refundMinor).toBe("1000");
    // Credit repayment: 20000 (C out) + 20000 (A in) = 40000
    expect(totals.creditRepaymentMinor).toBe("40000");
  });

  it("calculates per-account totals", () => {
    const legs: TransactionLeg[] = [
      makeLeg({ accountId: "acc-a", direction: "INFLOW", amountMinor: 100000n, description: "Salary" }),
      makeLeg({ accountId: "acc-a", direction: "OUTFLOW", amountMinor: 5000n, description: "Groceries" }),
      // Transfer A->B (both legs)
      makeLeg({ accountId: "acc-a", direction: "OUTFLOW", amountMinor: 10000n, counterpartyAccountId: "acc-b", description: "Transfer to B" }),
      makeLeg({ accountId: "acc-b", direction: "INFLOW", amountMinor: 10000n, counterpartyAccountId: "acc-a", description: "Transfer from A" }),
      makeLeg({ accountId: "acc-a", direction: "OUTFLOW", amountMinor: 200n, isFee: true, counterpartyAccountId: "acc-b", description: "Transfer fee" }),
    ];

    const classified = legs.map(l => classifyLeg(l, ownedAccountIds));
    const accountTotals = calculateAccountTotals(classified, ownedAccounts);

    const accA = accountTotals.find(t => t.accountId === "acc-a")!;
    const accB = accountTotals.find(t => t.accountId === "acc-b")!;

    // Account A: income 100000, spend 5000 + 200 (fee) = 5200, transfer principal 10000 (out)
    expect(accA.incomeMinor).toBe("100000");
    expect(accA.spendMinor).toBe("5200");
    expect(accA.cashMinor).toBe("94800");
    expect(accA.transferPrincipalMinor).toBe("10000");
    expect(accA.transferFeeMinor).toBe("200");

    // Account B: no income (transfer principal is not income), no spend
    expect(accB.incomeMinor).toBe("0");
    expect(accB.spendMinor).toBe("0");
    expect(accB.cashMinor).toBe("0");
    expect(accB.transferPrincipalMinor).toBe("10000");
  });

  it("handles minor units correctly in totals", () => {
    const eurLeg = makeLeg({ accountId: "acc-a", direction: "INFLOW", amountMinor: 1234n }); // 12.34 EUR
    const jpyLeg = makeLeg({ accountId: "acc-a", direction: "OUTFLOW", amountMinor: 50000n }); // 50000 JPY
    const kwdLeg = makeLeg({ accountId: "acc-a", direction: "INFLOW", amountMinor: 1234n }); // 1.234 KWD

    const classified = [eurLeg, jpyLeg, kwdLeg].map(l => classifyLeg(l, ownedAccountIds));
    const totals = calculateWorkspaceTotals(classified, ownedAccounts);

    // Amounts are formatted by currency in display layer; here we verify minor units
    // Income: 1234 (EUR) + 1234 (KWD) = 2468
    // Spend: 50000 (JPY)
    expect(totals.incomeMinor).toBe("2468");
    expect(totals.spendMinor).toBe("50000");
  });

  it("selected-account totals differ from workspace totals only by excluded accounts", () => {
    const legs: TransactionLeg[] = [
      makeLeg({ accountId: "acc-a", direction: "INFLOW", amountMinor: 100000n }),
      makeLeg({ accountId: "acc-b", direction: "OUTFLOW", amountMinor: 5000n }),
    ];

    const classified = legs.map(l => classifyLeg(l, ownedAccountIds));

    // Workspace totals (all owned accounts)
    const workspaceTotals = calculateWorkspaceTotals(classified, ownedAccounts);
    expect(workspaceTotals.incomeMinor).toBe("100000");
    expect(workspaceTotals.spendMinor).toBe("5000");

    // Selected account (acc-a only)
    const selectedAccounts = new Map<string, { currency: string }>([["acc-a", { currency: "EUR" }]]);
    const selectedTotals = calculateWorkspaceTotals(classified, selectedAccounts);
    expect(selectedTotals.incomeMinor).toBe("100000");
    expect(selectedTotals.spendMinor).toBe("0");

    // Selected account (acc-b only)
    const selectedAccountsB = new Map<string, { currency: string }>([["acc-b", { currency: "USD" }]]);
    const selectedTotalsB = calculateWorkspaceTotals(classified, selectedAccountsB);
    expect(selectedTotalsB.incomeMinor).toBe("0");
    expect(selectedTotalsB.spendMinor).toBe("5000");
  });
});