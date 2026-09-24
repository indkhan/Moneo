// E03-S02 shared deterministic cash/spend/income calculations (architecture §§536–538).
// Pure functions: no DB, no side effects, exact minor-unit BigInt arithmetic.
// Classification rules:
// - Transfer: both legs in owned accounts → principal excluded from spend/income; fee leg → expense
// - Refund: negative spend in same posting period (not income)
// - Credit repayment: transfer when both accounts owned
// - Owned accounts determined by workspace_id + account_id presence in accounts table

import { createHash } from "node:crypto";
import { formatDecimalBigint, formatSignedDecimalBigint } from "../money.ts";

export type OwnedAccount = { workspaceId: string; accountId: string; currency: string };

export type TransactionLeg = {
  accountId: string;
  amountMinor: bigint;
  currency: string;
  direction: "INFLOW" | "OUTFLOW";
  effectiveDate: string;
  description: string;
  source: "imported" | "manual";
  category?: string;
  counterpartyAccountId?: string;
  isFee?: boolean;
  isRefund?: boolean;
  isCreditRepayment?: boolean;
};

export type ClassifiedLeg = TransactionLeg & {
  classification: "income" | "spend" | "transfer_principal" | "transfer_fee" | "refund" | "credit_repayment";
  signedAmountMinor: bigint; // positive for income, negative for spend
};

export type CurrencyTotals = {
  currency: string;
  incomeMinor: string; // decimal string
  spendMinor: string; // decimal string (positive)
  cashMinor: string; // decimal string (signed: income - spend)
  transferPrincipalMinor: string; // decimal string
  transferFeeMinor: string; // decimal string
  refundMinor: string; // decimal string (positive amount refunded)
  creditRepaymentMinor: string; // decimal string
};

export type WorkspaceTotals = {
  byCurrency: CurrencyTotals[];
  inputsHash: string;
  resultsHash: string;
};

export type AccountTotals = {
  accountId: string;
  currency: string;
  incomeMinor: string;
  spendMinor: string;
  cashMinor: string;
  transferPrincipalMinor: string;
  transferFeeMinor: string;
  refundMinor: string;
  creditRepaymentMinor: string;
};

type AccountTotalsInternal = {
  accountId: string;
  currency: string;
  incomeMinor: bigint;
  spendMinor: bigint;
  cashMinor: bigint;
  transferPrincipalMinor: bigint;
  transferFeeMinor: bigint;
  refundMinor: bigint;
  creditRepaymentMinor: bigint;
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Classify a single transaction leg based on ownership and metadata. */
export function classifyLeg(leg: TransactionLeg, ownedAccounts: Set<string>): ClassifiedLeg {
  const isOwned = ownedAccounts.has(leg.accountId);
  const isCounterpartyOwned = leg.counterpartyAccountId ? ownedAccounts.has(leg.counterpartyAccountId) : false;

  let classification: ClassifiedLeg["classification"];
  let signedAmountMinor: bigint;

  // Fee legs are always expenses (spend)
  if (leg.isFee) {
    classification = "transfer_fee";
    signedAmountMinor = leg.direction === "OUTFLOW" ? -leg.amountMinor : leg.amountMinor;
  }
  // Refund: negative spend in posting period
  else if (leg.isRefund) {
    classification = "refund";
    // Refund reduces spend: if original was OUTFLOW (spend), refund is INFLOW (negative spend)
    signedAmountMinor = leg.direction === "INFLOW" ? -leg.amountMinor : leg.amountMinor;
  }
  // Credit repayment: transfer when both accounts owned
  else if (leg.isCreditRepayment && isOwned && isCounterpartyOwned) {
    classification = "credit_repayment";
    signedAmountMinor = 0n; // Principal excluded from income/spend
  }
  // Transfer: both legs in owned accounts
  else if (isOwned && isCounterpartyOwned) {
    classification = "transfer_principal";
    signedAmountMinor = 0n; // Principal excluded from income/spend
  }
  // Regular income/spend
  else if (isOwned) {
    if (leg.direction === "INFLOW") {
      classification = "income";
      signedAmountMinor = leg.amountMinor;
    } else {
      classification = "spend";
      signedAmountMinor = -leg.amountMinor;
    }
  } else {
    // Not owned - ignore (should not happen with proper filtering)
    classification = "income";
    signedAmountMinor = 0n;
  }

  return { ...leg, classification, signedAmountMinor };
}

/** Calculate workspace totals from classified legs. */
export function calculateWorkspaceTotals(
  legs: ClassifiedLeg[],
  ownedAccounts: Map<string, { currency: string }>,
): WorkspaceTotals {
  // Filter to only legs belonging to owned accounts
  const ownedLegs = legs.filter(l => ownedAccounts.has(l.accountId));

  const totals = new Map<string, Omit<AccountTotalsInternal, "accountId">>();

  for (const leg of ownedLegs) {
    const currency = ownedAccounts.get(leg.accountId)!.currency;
    if (currency !== leg.currency) throw new Error("account_currency_mismatch");
    const total = totals.get(currency) ?? {
      currency,
      incomeMinor: 0n,
      spendMinor: 0n,
      cashMinor: 0n,
      transferPrincipalMinor: 0n,
      transferFeeMinor: 0n,
      refundMinor: 0n,
      creditRepaymentMinor: 0n,
    };
    totals.set(currency, total);
    switch (leg.classification) {
      case "income":
        total.incomeMinor += leg.amountMinor;
        break;
      case "spend":
        total.spendMinor += leg.amountMinor;
        break;
      case "transfer_principal":
        total.transferPrincipalMinor += leg.amountMinor;
        break;
      case "transfer_fee":
        total.transferFeeMinor += leg.amountMinor;
        total.spendMinor += leg.amountMinor;
        break;
      case "refund":
        total.refundMinor += leg.amountMinor;
        total.spendMinor -= leg.amountMinor;
        break;
      case "credit_repayment":
        total.creditRepaymentMinor += leg.amountMinor;
        break;
    }
    total.cashMinor = total.incomeMinor - total.spendMinor;
  }

  const byCurrency = Array.from(totals.values()).sort((a, b) => a.currency.localeCompare(b.currency)).map((total) => ({
    currency: total.currency,
    incomeMinor: formatDecimalBigint(total.incomeMinor),
    spendMinor: formatSignedDecimalBigint(total.spendMinor),
    cashMinor: formatSignedDecimalBigint(total.cashMinor),
    transferPrincipalMinor: formatDecimalBigint(total.transferPrincipalMinor),
    transferFeeMinor: formatDecimalBigint(total.transferFeeMinor),
    refundMinor: formatDecimalBigint(total.refundMinor),
    creditRepaymentMinor: formatDecimalBigint(total.creditRepaymentMinor),
  }));
  const inputs = ownedLegs.map(l => `${l.accountId}:${l.currency}:${l.amountMinor}:${l.direction}:${l.classification}`).sort().join("|");
  const results = JSON.stringify(byCurrency);

  return {
    byCurrency,
    inputsHash: sha256(inputs),
    resultsHash: sha256(results),
  };
}

/** Calculate per-account totals from classified legs. */
export function calculateAccountTotals(
  legs: ClassifiedLeg[],
  ownedAccounts: Map<string, { currency: string }>,
): AccountTotals[] {
  const accountMap = new Map<string, AccountTotalsInternal>();

  for (const leg of legs) {
    if (!ownedAccounts.has(leg.accountId)) continue;
    const acc = ownedAccounts.get(leg.accountId)!;
    if (acc.currency !== leg.currency) throw new Error("account_currency_mismatch");
    let totals = accountMap.get(leg.accountId);
    if (!totals) {
      totals = {
        accountId: leg.accountId,
        currency: acc.currency,
        incomeMinor: 0n,
        spendMinor: 0n,
        cashMinor: 0n,
        transferPrincipalMinor: 0n,
        transferFeeMinor: 0n,
        refundMinor: 0n,
        creditRepaymentMinor: 0n,
      };
      accountMap.set(leg.accountId, totals);
    }

    switch (leg.classification) {
      case "income":
        totals.incomeMinor += leg.amountMinor;
        break;
      case "spend":
        totals.spendMinor += leg.amountMinor;
        break;
      case "transfer_principal":
        totals.transferPrincipalMinor += leg.amountMinor;
        break;
      case "transfer_fee":
        totals.transferFeeMinor += leg.amountMinor;
        totals.spendMinor += leg.amountMinor;
        break;
      case "refund":
        totals.refundMinor += leg.amountMinor;
        totals.spendMinor -= leg.amountMinor;
        break;
      case "credit_repayment":
        totals.creditRepaymentMinor += leg.amountMinor;
        break;
    }
    totals.cashMinor = totals.incomeMinor - totals.spendMinor;
  }

  return Array.from(accountMap.values()).map(t => ({
    accountId: t.accountId,
    currency: t.currency,
    incomeMinor: formatDecimalBigint(t.incomeMinor),
    spendMinor: formatDecimalBigint(t.spendMinor),
    cashMinor: formatSignedDecimalBigint(t.cashMinor),
    transferPrincipalMinor: formatDecimalBigint(t.transferPrincipalMinor),
    transferFeeMinor: formatDecimalBigint(t.transferFeeMinor),
    refundMinor: formatDecimalBigint(t.refundMinor),
    creditRepaymentMinor: formatDecimalBigint(t.creditRepaymentMinor),
  }));
}

/** Filter legs to only those belonging to owned accounts in the workspace. */
export function filterOwnedLegs(
  legs: TransactionLeg[],
  ownedAccountIds: Set<string>,
): TransactionLeg[] {
  return legs.filter(l => ownedAccountIds.has(l.accountId));
}
