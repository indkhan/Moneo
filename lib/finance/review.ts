import { netWorth, summarizeCashflow, type CashflowTransaction } from "./calculations";
import { resolveBalances, type BalanceTransaction, type BalanceSnapshot } from "./balances";

type Account = { id: string; name: string; currency_code: string };
type Transaction = { amount_minor: string; currency_code: string; status: string; kind: string; review_reasons?: string[] };

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
