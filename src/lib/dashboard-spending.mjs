export function summarizeMonthlySpending(transactions, month) {
  const currencies = new Map();
  for (const transaction of transactions) {
    if (!transaction.bookingDate.startsWith(`${month}-`)) continue;
    if (transaction.status && transaction.status !== 'booked') continue;
    const amount = BigInt(transaction.amountMinor);
    if (amount >= 0n) continue;
    const summary = currencies.get(transaction.currency) ?? {
      currency: transaction.currency,
      currencyMinorUnit: transaction.currencyMinorUnit,
      total: 0n,
      categories: new Map(),
    };
    const categoryId = transaction.category?.categoryId ?? 'uncategorised';
    const outflow = -amount;
    summary.total += outflow;
    summary.categories.set(categoryId, (summary.categories.get(categoryId) ?? 0n) + outflow);
    currencies.set(transaction.currency, summary);
  }
  return [...currencies.values()]
    .sort((left, right) => left.currency.localeCompare(right.currency))
    .map((summary) => ({
      currency: summary.currency,
      currencyMinorUnit: summary.currencyMinorUnit,
      totalMinor: summary.total.toString(),
      categories: [...summary.categories.entries()]
        .sort(([, left], [, right]) => left === right ? 0 : left > right ? -1 : 1)
        .map(([categoryId, amount]) => ({ categoryId, amountMinor: amount.toString() })),
    }));
}
