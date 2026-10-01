// Monthly category spending progress. All money is signed bigint minor
// units; no floats. Spending = posted ordinary expenses (negative amounts)
// as a positive total, minus refunds posted in the same month. Linked
// refunds attribute to the ORIGINAL transaction's category (a
// refund reduces spending in its posting period, even when the original is
// older), retaining the refund's posting currency; standalone refunds use
// their own category. Transfers, pending,
// income, other currencies and other months are excluded.

export type SpendingPlanTransaction = {
  amountMinor: bigint;
  currencyCode: string;
  status: string;
  kind: string;
  categoryId: string | null;
  postedOn: string;
  // Resolved from refund_of_id -> original transaction, when present.
  refundOfCategoryId?: string | null;
  refundOfCurrencyCode?: string | null;
};

export function monthPrefix(today = new Date(), timeZone = "Europe/Berlin"): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(today);
  return `${parts.find(part => part.type === "year")!.value}-${parts.find(part => part.type === "month")!.value}`;
}

export function nextMonthStart(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon, 1)).toISOString().slice(0, 10);
}

export function spendingForCategory(
  transactions: SpendingPlanTransaction[],
  categoryId: string,
  currencyCode: string,
  month: string,
): bigint {
  let spent = 0n;
  for (const transaction of transactions) {
    if (transaction.status !== "posted") continue;
    if (transaction.kind === "transfer") continue;
    if (!transaction.postedOn.startsWith(month)) continue;
    if (transaction.kind === "refund") {
      const linked = transaction.refundOfCategoryId !== undefined;
      const effectiveCategory = linked ? transaction.refundOfCategoryId : transaction.categoryId;
      const effectiveCurrency = transaction.currencyCode;
      if (effectiveCategory !== categoryId || effectiveCurrency !== currencyCode) continue;
      if (transaction.amountMinor <= 0n) continue;
      spent -= transaction.amountMinor;
    } else {
      if (transaction.categoryId !== categoryId) continue;
      if (transaction.currencyCode !== currencyCode) continue;
      if (transaction.amountMinor >= 0n) continue;
      spent += -transaction.amountMinor;
    }
  }
  return spent;
}
