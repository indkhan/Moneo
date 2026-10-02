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
  reviewReasons?: string[];
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
    if (transaction.reviewReasons?.length) continue;
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

export type MonthlyLimit = { effective_month: string; limit_minor: string; enabled: boolean; version: number };
export function rolloverBudget(transactions: SpendingPlanTransaction[], categoryId: string, currency: string, startsMonth: string, month: string, currentLimit: bigint, history: MonthlyLimit[]):
  | { status: "unavailable"; missingInput: string }
  | { status: "available"; carriedMinor: bigint; allowanceMinor: bigint; spentMinor: bigint; remainingMinor: bigint } {
  if (![startsMonth, month].every(value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value))) throw new Error("Invalid budget month");
  const monthIndex = (value: string) => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
  const elapsed = monthIndex(month) - monthIndex(startsMonth);
  // ponytail: ten years of rollover history; longer histories need paged aggregation.
  if (elapsed > 120) return { status: "unavailable", missingInput: "Rollover exceeds the supported ten-year history; choose a later start month" };
  let carriedMinor = 0n;
  const ordered = [...history].sort((a, b) => a.effective_month.localeCompare(b.effective_month) || a.version - b.version);
  for (let offset = 0; offset < elapsed; offset++) {
    const index = monthIndex(startsMonth) + offset;
    const previous = `${Math.floor(index / 12).toString().padStart(4, "0")}-${(index % 12 + 1).toString().padStart(2, "0")}`;
    const known = ordered.filter(item => item.effective_month.slice(0, 7) <= previous).at(-1);
    if (!known) return { status: "unavailable", missingInput: `No recorded budget target for ${previous}; choose a supported rollover start month` };
    if (transactions.some(item => item.postedOn.startsWith(previous) && item.status === "posted" && item.reviewReasons?.length && item.currencyCode === currency && (item.categoryId === null || item.categoryId === categoryId || item.refundOfCategoryId === categoryId))) return { status: "unavailable", missingInput: `Financial classification needs review in ${previous}` };
    if (!known.enabled) { carriedMinor = 0n; continue; }
    carriedMinor += BigInt(known.limit_minor) - spendingForCategory(transactions, categoryId, currency, previous);
  }
  const spentMinor = spendingForCategory(transactions, categoryId, currency, month);
  const allowanceMinor = currentLimit + carriedMinor;
  return { status: "available", carriedMinor, allowanceMinor, spentMinor, remainingMinor: allowanceMinor - spentMinor };
}
