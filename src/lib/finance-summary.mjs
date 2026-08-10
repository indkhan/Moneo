export function summarizeByCurrency(transactions) {
  const summaries = new Map();
  for (const transaction of transactions) {
    if (transaction.status && transaction.status !== 'booked') continue;
    const summary = summaries.get(transaction.currency) ?? {
      currency: transaction.currency,
      currencyMinorUnit: transaction.currencyMinorUnit,
      income: 0n,
      outflow: 0n,
      count: 0,
    };
    const amount = BigInt(transaction.amountMinor);
    if (amount < 0n) summary.outflow += -amount;
    else summary.income += amount;
    summary.count += 1;
    summaries.set(transaction.currency, summary);
  }
  return [...summaries.values()]
    .sort((left, right) => left.currency.localeCompare(right.currency))
    .map((summary) => ({
      currency: summary.currency,
      currencyMinorUnit: summary.currencyMinorUnit,
      incomeMinor: summary.income.toString(),
      outflowMinor: summary.outflow.toString(),
      netMinor: (summary.income - summary.outflow).toString(),
      count: summary.count,
    }));
}

function bookedInOrder(transactions) {
  return transactions
    .filter((transaction) => !transaction.status || transaction.status === 'booked')
    .toSorted((left, right) => (
      left.bookingDate.localeCompare(right.bookingDate)
      || left.source.rowNumber - right.source.rowNumber
    ));
}

export function latestBalanceByAccount(transactions) {
  const balances = {};
  for (const transaction of bookedInOrder(transactions)) {
    const current = balances[transaction.accountId];
    balances[transaction.accountId] = {
      amountMinor: transaction.balanceAfterMinor === undefined
        ? ((current?.amountMinor ?? 0n) + BigInt(transaction.amountMinor))
        : BigInt(transaction.balanceAfterMinor),
      currency: transaction.currency,
      currencyMinorUnit: transaction.currencyMinorUnit,
      bookingDate: transaction.bookingDate,
      sourceBacked: current?.sourceBacked || transaction.balanceAfterMinor !== undefined,
    };
  }
  return Object.fromEntries(Object.entries(balances).map(([accountId, balance]) => [
    accountId,
    {
      amountMinor: balance.amountMinor.toString(),
      currency: balance.currency,
      currencyMinorUnit: balance.currencyMinorUnit,
      bookingDate: balance.bookingDate,
      basis: balance.sourceBacked ? 'source-backed' : 'calculated-from-zero',
    },
  ]));
}

export function balanceSeriesByCurrency(transactions) {
  const groups = new Map();
  for (const transaction of bookedInOrder(transactions)) {
    const group = groups.get(transaction.currency) ?? {
      currency: transaction.currency,
      currencyMinorUnit: transaction.currencyMinorUnit,
      balances: new Map(),
      months: new Map(),
      sourceBacked: false,
    };
    const current = group.balances.get(transaction.accountId) ?? 0n;
    group.balances.set(
      transaction.accountId,
      transaction.balanceAfterMinor === undefined
        ? current + BigInt(transaction.amountMinor)
        : BigInt(transaction.balanceAfterMinor),
    );
    group.sourceBacked ||= transaction.balanceAfterMinor !== undefined;
    group.months.set(
      transaction.bookingDate.slice(0, 7),
      [...group.balances.values()].reduce((sum, balance) => sum + balance, 0n),
    );
    groups.set(transaction.currency, group);
  }

  return [...groups.values()]
    .sort((left, right) => left.currency.localeCompare(right.currency))
    .map((group) => ({
      currency: group.currency,
      currencyMinorUnit: group.currencyMinorUnit,
      basis: group.sourceBacked ? 'source-backed' : 'calculated-from-zero',
      points: [...group.months].map(([month, amount]) => ({
        month,
        amountMinor: amount.toString(),
      })),
    }));
}
