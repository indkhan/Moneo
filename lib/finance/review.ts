import { netWorth, summarizeCashflow, type CashflowTransaction } from "./calculations";
import { resolveBalances, type BalanceTransaction, type BalanceSnapshot } from "./balances";
import { goalContributionProjection } from "./goals";
import { budgetProgress, type MonthlyLimit } from "./spending-plans";
import { wealthEvidence, type WealthValue } from "./wealth";

type Account = { id: string; name: string; currency_code: string };
type Transaction = { amount_minor: string; currency_code: string; status: string; kind: string; review_reasons?: string[] };
export type ReviewTransaction = Transaction & { id: string; parent_transaction_id?: string; posted_on: string; category_id: string | null; merchant_id: string | null; refund_of_id?: string | null; refund_category_id?: string | null };

export function reviewNetWorth(accountTotals: Record<string, string | null>, wealth: WealthValue[], today: string) {
  const dated = wealthEvidence(wealth, today);
  const currencies = [...new Set([...Object.keys(accountTotals), ...wealth.filter(row => !row.linked_account_id).map(row => row.currency_code)])];
  return Object.fromEntries(currencies.map(currency => {
    if (accountTotals[currency] === null || wealth.some(row => !row.linked_account_id && row.currency_code === currency && row.as_of !== today)) return [currency, null];
    const total = BigInt(accountTotals[currency] ?? "0") + dated.included.filter(row => row.currencyCode === currency).reduce((sum, row) => sum + row.amountMinor, 0n);
    return [currency, total.toString()];
  }));
}

export function buildPlanningReview(input: {
  today: string;
  goals: { id: string; name: string; currency_code: string; target_minor: string; recorded_saved_minor: string | null; saved_as_of: string | null; planned_monthly_minor: string; contribution_starts_on: string | null; target_date: string | null; status: string }[];
  allocations: { goal_id: string; amount_minor: string }[];
  budgets: { id: string; category_id: string; currency_code: string; limit_minor: string; enabled: boolean; rollover?: boolean; rollover_from?: string }[];
  budgetHistory?: (MonthlyLimit & { plan_id: string })[];
  transactions: ReviewTransaction[];
  categories: { id: string; name: string }[];
}) {
  return {
    goals: input.goals.filter(goal => goal.status === "active").map(goal => {
      const saved = goal.recorded_saved_minor !== null && goal.saved_as_of !== null && goal.saved_as_of <= input.today ? BigInt(goal.recorded_saved_minor) : null;
      const projection = goalContributionProjection({ targetMinor: BigInt(goal.target_minor), savedMinor: saved, monthlyMinor: BigInt(goal.planned_monthly_minor), startsOn: goal.contribution_starts_on }, input.today);
      return { id: goal.id, name: goal.name, currency: goal.currency_code, targetMinor: goal.target_minor,
        recordedSavedMinor: saved?.toString() ?? null, savedAsOf: goal.saved_as_of,
        reservedMinor: input.allocations.filter(allocation => allocation.goal_id === goal.id).reduce((sum, allocation) => sum + BigInt(allocation.amount_minor), 0n).toString(),
        remainingMinor: projection.remainingMinor?.toString() ?? null, plannedMonthlyMinor: goal.planned_monthly_minor,
        contributionStartsOn: goal.contribution_starts_on, completionDate: projection.completionDate, targetDate: goal.target_date,
        targetConflict: projection.completionDate && goal.target_date ? projection.completionDate > goal.target_date : null, link: "/plan" };
    }),
    budgets: input.budgets.filter(budget => budget.enabled).map(budget => {
      const rows = input.transactions.map(row => ({ amountMinor: BigInt(row.amount_minor), currencyCode: row.currency_code, status: row.status, kind: row.kind, reviewReasons: row.review_reasons, postedOn: row.posted_on, categoryId: row.category_id, ...(row.refund_of_id ? { refundOfCategoryId: row.refund_category_id ?? null } : {}) }));
      const month = input.today.slice(0, 7);
      const progress = budgetProgress(rows, budget.category_id, budget.currency_code, month, BigInt(budget.limit_minor), budget.rollover ? { startsMonth: budget.rollover_from?.slice(0, 7) ?? null, history: (input.budgetHistory ?? []).filter(item => item.plan_id === budget.id) } : undefined);
      return { id: budget.id, category: input.categories.find(category => category.id === budget.category_id)?.name ?? "Unknown", currency: budget.currency_code,
        month, limitMinor: budget.limit_minor, spentMinor: progress.spentMinor.toString(), remainingMinor: progress.remainingMinor?.toString() ?? null, overLimit: progress.overLimit,
        carriedMinor: progress.carriedMinor?.toString() ?? null, allowanceMinor: progress.allowanceMinor?.toString() ?? null,
        limitation: progress.limitation, partial: progress.partial, link: "/plan/spending" };
    }),
    limits: ["Recorded savings are dated manual evidence; reservations are separate virtual earmarks", "Contribution dates assume the stated monthly plan and do not prove affordability", "Monthly budgets count reviewed booked spending and refunds; incomplete imports may understate pressure"],
  };
}

export function buildReviewInvestigation(rows: ReviewTransaction[], period: { from: string; to: string }, categories: { id: string; name: string }[], merchants: { id: string; name: string }[]) {
  const first = Date.parse(`${period.from}T00:00:00Z`), last = Date.parse(`${period.to}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) throw new Error("Invalid review period");
  const days = Math.floor((last - first) / 86400000) + 1;
  const comparisonPeriod = { from: new Date(first - days * 86400000).toISOString().slice(0, 10), to: new Date(first - 86400000).toISOString().slice(0, 10) };
  const current = rows.filter(row => row.posted_on >= period.from && row.posted_on <= period.to);
  function groups(column: "category_id" | "merchant_id", names: { id: string; name: string }[]) {
    const labels = new Map(names.map(name => [name.id, name.name]));
    const result = new Map<string, { id: string | null; name: string; currency: string; current: bigint; previous: bigint; sources: Set<string> }>();
    for (const row of rows) {
      if (row.status !== "posted" || row.kind === "transfer" || row.review_reasons?.length || row.posted_on < comparisonPeriod.from || row.posted_on > period.to) continue;
      const amount = BigInt(row.amount_minor), spending = amount < 0n ? -amount : row.kind === "refund" ? -amount : 0n;
      if (spending === 0n) continue;
      const id = column === "category_id" && row.kind === "refund" && row.refund_of_id ? row.refund_category_id ?? null : row[column], key = JSON.stringify([id, row.currency_code]);
      const group = result.get(key) ?? { id, name: id ? labels.get(id) ?? "Unknown" : column === "category_id" ? "Uncategorized" : "Unknown merchant", currency: row.currency_code, current: 0n, previous: 0n, sources: new Set<string>() };
      if (row.posted_on >= period.from) { group.current += spending; if (group.sources.size < 5) group.sources.add(`/money/transactions?transaction=${row.parent_transaction_id ?? row.id}`); }
      else group.previous += spending;
      result.set(key, group);
    }
    return [...result.values()].sort((a, b) => a.current > b.current ? -1 : a.current < b.current ? 1 : a.name.localeCompare(b.name)).slice(0, 50)
      .map(group => ({ id: group.id, name: group.name, currency: group.currency, spendingMinor: group.current.toString(), previousSpendingMinor: group.previous.toString(), changeMinor: (group.current - group.previous).toString(), sourceLinks: [...group.sources] }));
  }
  return { comparisonPeriod, categories: groups("category_id", categories), merchants: groups("merchant_id", merchants),
    classificationReview: { excludedRows: current.filter(row => row.status === "posted" && row.review_reasons?.length).length, link: "/import" },
    limits: ["Equal-length calendar periods; incomplete imports can affect comparisons", "Unreviewed classifications, pending rows and internal transfers are excluded", "Group changes describe booked evidence, not causes; refunds follow their attributable category"] };
}

export function buildReviewEvidence(accounts: Account[], snapshots: BalanceSnapshot[], transactions: Transaction[], from: string, to: string,
  balanceEvidence: { asOf: string; ledger: BalanceTransaction[]; timeZone?: string } = { asOf: new Date().toISOString(), ledger: [] }) {
  const accountEvidence = resolveBalances(accounts, snapshots, balanceEvidence.ledger, balanceEvidence.asOf, balanceEvidence.timeZone).map(account => {
    const balance = account.balance;
    return { id: account.id, name: account.name, currencyCode: account.currency_code,
      balanceMinor: balance.amount_minor, snapshotBalanceMinor: balance.snapshot_amount_minor,
      snapshotCurrencyCode: balance.snapshot_currency_code,
      estimatedBalanceMinor: balance.estimated_amount_minor, balanceStatus: balance.status,
      balanceWarnings: balance.warnings, evaluatedAt: balance.evaluated_at,
      asOf: balance.as_of, provenance: balance.provenance };
  });
  const currencies = [...new Set([...accounts.map(account => account.currency_code), ...transactions.map(transaction => transaction.currency_code)])];
  const cashflow: Record<string, { incomeMinor: string; spendingMinor: string; netMinor: string; excludedReviewRows?: number; partial?: boolean }> = {};
  const worth: Record<string, string | null> = {};
  for (const currency of currencies) {
    const relevant = transactions.filter(transaction => transaction.currency_code === currency);
    if (relevant.length) {
      const totals = summarizeCashflow(relevant.map(transaction => ({ amountMinor: BigInt(transaction.amount_minor), currencyCode: currency,
        status: transaction.status as CashflowTransaction["status"], kind: transaction.kind as CashflowTransaction["kind"], reviewReasons: transaction.review_reasons })), currency)!;
      cashflow[currency] = { incomeMinor: totals.incomeMinor.toString(), spendingMinor: totals.spendingMinor.toString(), netMinor: totals.netMinor.toString(),
        ...(totals.excludedReviewRows ? { excludedReviewRows: totals.excludedReviewRows, partial: true } : {}) };
    }
    const inCurrency = accountEvidence.filter(account => account.currencyCode === currency);
    if (inCurrency.length) worth[currency] = netWorth(inCurrency.map(account => ({ amountMinor: account.balanceMinor === null ? null : BigInt(account.balanceMinor), currencyCode: currency })), currency)?.toString() ?? null;
  }
  return { period: { from, to }, accounts: accountEvidence, cashflow, netWorth: worth };
}
