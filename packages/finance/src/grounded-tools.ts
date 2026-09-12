export type GroundedAccount = { id: string; name: string; currencyCode: string; balanceMinor: string | null };
export type GroundedTransaction = { id: string; accountId: string; direction: "debit" | "credit"; amountMinor: string; effectiveDate: string; description: string; category: string | null; counterparty: string | null };
type Period = { dateFrom: string; dateTo: string };
type Evidence = { evidenceRef: string; dataCutoff: string; calculationMetadata: { eligibleAccountCount: number; filters: Record<string, unknown> }; rows: Array<{ id: string; accountId: string }> };
type ToolResult<T> = { result: T; evidence: Evidence };

export function createGroundedFinanceTools(source: { accounts: GroundedAccount[]; transactions: GroundedTransaction[]; excludedAccountIds?: ReadonlySet<string>; dataCutoff: string }) {
  const excluded = source.excludedAccountIds ?? new Set<string>();
  const accounts = source.accounts.filter((a) => !excluded.has(a.id));
  const transactions = source.transactions.filter((t) => !excluded.has(t.accountId));
  const evidence = (filters: Record<string, unknown>, rows: GroundedTransaction[]): Evidence => ({
    evidenceRef: `ev_${Buffer.from(JSON.stringify({ filters, ids: rows.map((r) => r.id) })).toString("base64url")}`,
    dataCutoff: source.dataCutoff, calculationMetadata: { eligibleAccountCount: accounts.length, filters }, rows: rows.map((r) => ({ id: r.id, accountId: r.accountId })),
  });
  const filtered = (period: Period, extra?: (row: GroundedTransaction) => boolean) => transactions.filter((row) => row.effectiveDate >= period.dateFrom && row.effectiveDate <= period.dateTo && (!extra || extra(row)));
  const aggregate = (period: Period, field: "category" | "counterparty", value?: string): ToolResult<Array<{ key: string; amountMinor: string; transactionCount: number }>> => {
    const rows = filtered(period, (row) => row.direction === "debit" && (value === undefined || row[field] === value));
    const groups = new Map<string, { amount: bigint; count: number }>();
    for (const row of rows) { const key = row[field] ?? "Uncategorized"; const group = groups.get(key) ?? { amount: 0n, count: 0 }; group.amount += BigInt(row.amountMinor); group.count++; groups.set(key, group); }
    return { result: [...groups].map(([key, value]) => ({ key, amountMinor: value.amount.toString(), transactionCount: value.count })).sort((a, b) => Number(BigInt(b.amountMinor) - BigInt(a.amountMinor))), evidence: evidence({ ...period, [field]: value }, rows) };
  };
  return {
    listAccounts: (): ToolResult<GroundedAccount[]> => ({ result: accounts, evidence: { ...evidence({}, []), rows: accounts.map((a) => ({ id: a.id, accountId: a.id })) } }),
    getBalances: (): ToolResult<GroundedAccount[]> => ({ result: accounts, evidence: { ...evidence({}, []), rows: accounts.map((a) => ({ id: a.id, accountId: a.id })) } }),
    searchTransactions: (input: Partial<Period> & { text?: string } = {}): ToolResult<GroundedTransaction[]> => { const rows = transactions.filter((r) => (!input.dateFrom || r.effectiveDate >= input.dateFrom) && (!input.dateTo || r.effectiveDate <= input.dateTo) && (!input.text || r.description.toLowerCase().includes(input.text.toLowerCase()))); return { result: rows, evidence: evidence(input, rows) }; },
    getTransaction: (id: string): ToolResult<GroundedTransaction | null> => { const row = transactions.find((r) => r.id === id) ?? null; return { result: row, evidence: evidence({ id }, row ? [row] : []) }; },
    cashflow: (period: Period): ToolResult<{ incomeMinor: string; spendingMinor: string }> => { const rows = filtered(period); let income = 0n, spending = 0n; for (const r of rows) if (r.direction === "credit") income += BigInt(r.amountMinor); else spending += BigInt(r.amountMinor); return { result: { incomeMinor: income.toString(), spendingMinor: spending.toString() }, evidence: evidence(period, rows) }; },
    spendingByCategory: (input: Period & { category?: string }) => aggregate(input, "category", input.category),
    spendingByCounterparty: (input: Period & { counterparty?: string }) => aggregate(input, "counterparty", input.counterparty),
    comparePeriods: (input: { current: Period; previous: Period }): ToolResult<{ currentSpendingMinor: string; previousSpendingMinor: string; deltaMinor: string }> => { const total = (p: Period) => filtered(p, (r) => r.direction === "debit"); const current = total(input.current), previous = total(input.previous); const sum = (rows: GroundedTransaction[]) => rows.reduce((n, r) => n + BigInt(r.amountMinor), 0n); const a = sum(current), b = sum(previous); return { result: { currentSpendingMinor: a.toString(), previousSpendingMinor: b.toString(), deltaMinor: (a - b).toString() }, evidence: evidence(input, [...current, ...previous]) }; },
  };
}
