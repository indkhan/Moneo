import { netWorth, summarizeCashflow, type CashflowTransaction } from "./calculations";

type Account = { id: string; name: string; currency_code: string };
type Snapshot = { account_id: string; amount_minor: string; currency_code: string; as_of: string; provenance: string };
type Transaction = { amount_minor: string; currency_code: string; status: string; kind: string };

export function buildReviewEvidence(accounts: Account[], snapshots: Snapshot[], transactions: Transaction[], from: string, to: string) {
  const latest = new Map<string, Snapshot>();
  for (const snapshot of snapshots) {
    const previous = latest.get(snapshot.account_id);
    if (!previous || snapshot.as_of > previous.as_of) latest.set(snapshot.account_id, snapshot);
  }
  const accountEvidence = accounts.map(account => {
    const snapshot = latest.get(account.id);
    const usable = snapshot?.currency_code === account.currency_code ? snapshot : undefined;
    return { id: account.id, name: account.name, currencyCode: account.currency_code,
      balanceMinor: usable?.amount_minor ?? null, asOf: usable?.as_of ?? null, provenance: usable?.provenance ?? null };
  });
  const currencies = [...new Set([...accounts.map(account => account.currency_code), ...transactions.map(transaction => transaction.currency_code)])];
  const cashflow: Record<string, { incomeMinor: string; spendingMinor: string; netMinor: string }> = {};
  const worth: Record<string, string | null> = {};
  for (const currency of currencies) {
    const relevant = transactions.filter(transaction => transaction.currency_code === currency);
    if (relevant.length) {
      const totals = summarizeCashflow(relevant.map(transaction => ({ amountMinor: BigInt(transaction.amount_minor), currencyCode: currency,
        status: transaction.status as CashflowTransaction["status"], kind: transaction.kind as CashflowTransaction["kind"] })), currency)!;
      cashflow[currency] = { incomeMinor: totals.incomeMinor.toString(), spendingMinor: totals.spendingMinor.toString(), netMinor: totals.netMinor.toString() };
    }
    const inCurrency = accountEvidence.filter(account => account.currencyCode === currency);
    if (inCurrency.length) worth[currency] = netWorth(inCurrency.map(account => ({ amountMinor: account.balanceMinor === null ? null : BigInt(account.balanceMinor), currencyCode: currency })), currency)?.toString() ?? null;
  }
  return { period: { from, to }, accounts: accountEvidence, cashflow, netWorth: worth };
}
