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

export function latestBalanceByAccount(transactions) {
  const balances = {};
  for (const transaction of transactions) {
    if (transaction.balanceAfterMinor === undefined) continue;
    const current = balances[transaction.accountId];
    const order = `${transaction.bookingDate}|${String(transaction.source.rowNumber).padStart(10, '0')}`;
    if (!current || order > current.order) {
      balances[transaction.accountId] = {
        amountMinor: transaction.balanceAfterMinor,
        currency: transaction.currency,
        currencyMinorUnit: transaction.currencyMinorUnit,
        bookingDate: transaction.bookingDate,
        order,
      };
    }
  }
  return Object.fromEntries(Object.entries(balances).map(([accountId, balance]) => [
    accountId,
    {
      amountMinor: balance.amountMinor,
      currency: balance.currency,
      currencyMinorUnit: balance.currencyMinorUnit,
      bookingDate: balance.bookingDate,
    },
  ]));
}

export function balanceSeriesByCurrency(transactions) {
  const groups = new Map();
  for (const transaction of transactions) {
    if (transaction.status && transaction.status !== 'booked') continue;
    if (transaction.balanceAfterMinor === undefined) continue;
    const group = groups.get(transaction.currency) ?? {
      currency: transaction.currency,
      currencyMinorUnit: transaction.currencyMinorUnit,
      dates: new Map(),
    };
    const dateTransactions = group.dates.get(transaction.bookingDate) ?? [];
    dateTransactions.push(transaction);
    group.dates.set(transaction.bookingDate, dateTransactions);
    groups.set(transaction.currency, group);
  }

  return [...groups.values()]
    .sort((left, right) => left.currency.localeCompare(right.currency))
    .map((group) => {
      const balances = new Map();
      const points = [...group.dates.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, dateTransactions]) => {
          dateTransactions
            .sort((left, right) => left.source.rowNumber - right.source.rowNumber)
            .forEach((transaction) => balances.set(transaction.accountId, BigInt(transaction.balanceAfterMinor)));
          const amount = [...balances.values()].reduce((sum, balance) => sum + balance, 0n);
          return { date, amountMinor: amount.toString() };
        });
      return {
        currency: group.currency,
        currencyMinorUnit: group.currencyMinorUnit,
        points,
      };
    });
}
