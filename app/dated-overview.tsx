import {formatMoney} from "@/lib/finance/format";
import type {resolveBalances} from "@/lib/finance/balances";
import {wealthEvidence, type WealthValue} from "@/lib/finance/wealth";

export function DatedOverview({accounts, wealth, today, locale}: {
  accounts: ReturnType<typeof resolveBalances>; wealth: WealthValue[]; today: string; locale: string;
}) {
  const valuations = wealthEvidence(wealth, today, "observed");
  const observations = accounts.filter(account => !account.archived_at && account.balance.snapshot_valid && account.balance.snapshot_amount_minor !== null)
    .map(account => ({id: `account:${account.id}`, name: account.name, amount: BigInt(account.balance.snapshot_amount_minor!),
      currency: account.balance.snapshot_currency_code!}));
  observations.push(...valuations.included.map(value => ({id: `wealth:${value.id}`, name: value.name, amount: value.amountMinor,
    currency: value.currencyCode})));
  const totals = new Map<string, bigint>();
  for (const observation of observations) totals.set(observation.currency, (totals.get(observation.currency) ?? 0n) + observation.amount);
  return <details className="border-t border-border pt-3 text-sm">
    <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">Recorded net worth by currency</summary>
    <ul className="mt-3 space-y-1">{[...totals].map(([currency, amount]) => <li key={currency} className="font-mono font-semibold">{formatMoney(amount, currency, locale)}</li>)}</ul>
    <ul className="mt-3 divide-y divide-border">{observations.map(row => <li key={row.id} className="flex justify-between gap-3 py-2"><span className="truncate">{row.name}</span><span className="shrink-0 font-mono">{formatMoney(row.amount, row.currency, locale)}</span></li>)}</ul>
  </details>;
}
