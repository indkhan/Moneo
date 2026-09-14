export type GroundedAccount = {
  id: string;
  name: string;
  currencyCode: string;
  balanceMinor: string | null;
};
export type GroundedTransaction = {
  id: string;
  accountId: string;
  currencyCode?: string;
  status?: string;
  excludedFromAnalytics?: boolean;
  direction: "debit" | "credit";
  amountMinor: string;
  effectiveDate: string;
  description: string;
  category: string | null;
  counterparty: string | null;
};
type Period = { dateFrom: string; dateTo: string; currencyCode?: string };
type Evidence = {
  evidenceRef: string;
  dataCutoff: string;
  calculationMetadata: { eligibleAccountCount: number; filters: Record<string, unknown> };
  rows: Array<{ id: string; accountId: string }>;
};
type ToolResult<T> = { result: T; evidence: Evidence };

export function createGroundedFinanceTools(source: {
  accounts: GroundedAccount[];
  transactions: GroundedTransaction[];
  excludedAccountIds?: ReadonlySet<string>;
  dataCutoff: string;
}) {
  const excluded = source.excludedAccountIds ?? new Set<string>();
  const accounts = source.accounts.filter((a) => !excluded.has(a.id));
  const accountCurrency = new Map(accounts.map((account) => [account.id, account.currencyCode]));
  const transactions = source.transactions
    .filter((transaction) => accountCurrency.has(transaction.accountId))
    .map((transaction) => ({
      ...transaction,
      currencyCode: transaction.currencyCode ?? accountCurrency.get(transaction.accountId) ?? "",
    }));
  const evidence = (filters: Record<string, unknown>, rows: GroundedTransaction[]): Evidence => ({
    evidenceRef: `ev_${Buffer.from(JSON.stringify({ filters, ids: rows.map((r) => r.id) })).toString("base64url")}`,
    dataCutoff: source.dataCutoff,
    calculationMetadata: { eligibleAccountCount: accounts.length, filters },
    rows: rows.map((r) => ({ id: r.id, accountId: r.accountId })),
  });
  const filtered = (period: Period, extra?: (row: GroundedTransaction) => boolean) => {
    const availableCurrencies = new Set(transactions.map((row) => row.currencyCode));
    if (!period.currencyCode && availableCurrencies.size > 1)
      throw new Error("currencyCode is required for mixed-currency analytics.");
    return transactions.filter(
      (row) =>
        row.excludedFromAnalytics !== true &&
        row.status !== "PENDING" &&
        row.status !== "VOIDED" &&
        row.effectiveDate >= period.dateFrom &&
        row.effectiveDate <= period.dateTo &&
        (!period.currencyCode || row.currencyCode === period.currencyCode) &&
        (!extra || extra(row)),
    );
  };
  const amount = (row: GroundedTransaction): bigint => {
    if (!/^(0|[1-9]\d*)$/.test(row.amountMinor))
      throw new Error(`Invalid amountMinor for transaction ${row.id}.`);
    return BigInt(row.amountMinor);
  };
  const aggregate = (
    period: Period,
    field: "category" | "counterparty",
    value?: string,
  ): ToolResult<
    Array<{ key: string; amountMinor: string; transactionCount: number; currencyCode?: string }>
  > => {
    const rows = filtered(
      period,
      (row) => row.direction === "debit" && (value === undefined || row[field] === value),
    );
    const groups = new Map<string, { amount: bigint; count: number }>();
    for (const row of rows) {
      const key = row[field] ?? "Uncategorized";
      const group = groups.get(key) ?? { amount: 0n, count: 0 };
      group.amount += amount(row);
      group.count++;
      groups.set(key, group);
    }
    return {
      result: [...groups]
        .map(([key, group]) => ({
          key,
          amountMinor: group.amount.toString(),
          transactionCount: group.count,
          ...(period.currencyCode ? { currencyCode: period.currencyCode } : {}),
        }))
        .sort((a, b) =>
          a.amountMinor === b.amountMinor
            ? 0
            : BigInt(a.amountMinor) < BigInt(b.amountMinor)
              ? 1
              : -1,
        ),
      evidence: evidence({ ...period, [field]: value }, rows),
    };
  };
  return {
    listAccounts: (): ToolResult<GroundedAccount[]> => ({
      result: accounts,
      evidence: { ...evidence({}, []), rows: accounts.map((a) => ({ id: a.id, accountId: a.id })) },
    }),
    getBalances: (): ToolResult<GroundedAccount[]> => ({
      result: accounts,
      evidence: { ...evidence({}, []), rows: accounts.map((a) => ({ id: a.id, accountId: a.id })) },
    }),
    searchTransactions: (
      input: Partial<Period> & { text?: string } = {},
    ): ToolResult<GroundedTransaction[]> => {
      const rows = transactions.filter(
        (r) =>
          (!input.dateFrom || r.effectiveDate >= input.dateFrom) &&
          (!input.dateTo || r.effectiveDate <= input.dateTo) &&
          (!input.text || r.description.toLowerCase().includes(input.text.toLowerCase())),
      );
      return { result: rows, evidence: evidence(input, rows) };
    },
    getTransaction: (id: string): ToolResult<GroundedTransaction | null> => {
      const row = transactions.find((r) => r.id === id) ?? null;
      return { result: row, evidence: evidence({ id }, row ? [row] : []) };
    },
    cashflow: (
      period: Period,
    ): ToolResult<{ incomeMinor: string; spendingMinor: string; currencyCode?: string }> => {
      const rows = filtered(period);
      let income = 0n,
        spending = 0n;
      for (const r of rows)
        if (r.direction === "credit") income += amount(r);
        else spending += amount(r);
      return {
        result: {
          incomeMinor: income.toString(),
          spendingMinor: spending.toString(),
          ...(period.currencyCode ? { currencyCode: period.currencyCode } : {}),
        },
        evidence: evidence(period, rows),
      };
    },
    spendingByCategory: (input: Period & { category?: string }) =>
      aggregate(input, "category", input.category),
    spendingByCounterparty: (input: Period & { counterparty?: string }) =>
      aggregate(input, "counterparty", input.counterparty),
    comparePeriods: (input: {
      current: Period;
      previous: Period;
    }): ToolResult<{
      currentSpendingMinor: string;
      previousSpendingMinor: string;
      deltaMinor: string;
      currencyCode?: string;
    }> => {
      if (input.current.currencyCode !== input.previous.currencyCode)
        throw new Error("comparePeriods requires the same currencyCode for both periods.");
      const total = (p: Period) => filtered(p, (r) => r.direction === "debit");
      const current = total(input.current),
        previous = total(input.previous);
      const sum = (rows: GroundedTransaction[]) => rows.reduce((n, r) => n + amount(r), 0n);
      const a = sum(current),
        b = sum(previous);
      return {
        result: {
          currentSpendingMinor: a.toString(),
          previousSpendingMinor: b.toString(),
          deltaMinor: (a - b).toString(),
          ...(input.current.currencyCode ? { currencyCode: input.current.currencyCode } : {}),
        },
        evidence: evidence(input, [...current, ...previous]),
      };
    },
  };
}
