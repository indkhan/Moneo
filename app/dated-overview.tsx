import {calendarDate} from "@/lib/finance/calendar";
import {formatMoney} from "@/lib/finance/format";
import type {resolveBalances} from "@/lib/finance/balances";
import {wealthEvidence, type WealthValue} from "@/lib/finance/wealth";

export function DatedOverview({accounts, wealth, today, timeZone, locale}: {
  accounts: ReturnType<typeof resolveBalances>; wealth: WealthValue[]; today: string; timeZone: string; locale: string;
}) {
  const valuations = wealthEvidence(wealth, today, "observed");
  const observations = accounts.filter(account => !account.archived_at && account.balance.snapshot_valid && account.balance.snapshot_amount_minor !== null)
    .map(account => ({id: `account:${account.id}`, name: account.name, amount: BigInt(account.balance.snapshot_amount_minor!),
      currency: account.balance.snapshot_currency_code!, date: calendarDate(account.balance.as_of!, timeZone), provenance: account.balance.provenance!}));
  observations.push(...valuations.included.map(value => ({id: `wealth:${value.id}`, name: value.name, amount: value.amountMinor,
    currency: value.currencyCode, date: value.asOf, provenance: value.provenance})));
  const totals = new Map<string, bigint>();
  for (const observation of observations) totals.set(observation.currency, (totals.get(observation.currency) ?? 0n) + observation.amount);
  const missing = accounts.filter(account => !account.archived_at && !account.balance.snapshot_valid);
  const uncertain = accounts.filter(account => !account.archived_at && account.balance.snapshot_valid && account.balance.status === "ambiguous");
  return <details className="mt-5 border-t border-border pt-4 text-xs">
    <summary className="cursor-pointer font-medium text-brand">Recorded net worth by currency</summary>
    <p className="mt-2 text-muted-foreground">Latest recorded observations at or before {today}; not verified current funds. Different observation dates are shown below. No exchange rate or unrecorded activity is assumed.</p>
    <ul className="mt-3 space-y-1">{[...totals].map(([currency, amount]) => <li key={currency} className="font-mono font-semibold">{formatMoney(amount, currency, locale)}{missing.length > 0 || valuations.missingInputs.length > 0 ? " (partial)" : ""}</li>)}</ul>
    {!observations.length && <p className="mt-2">No usable dated observations.</p>}
    <ul className="mt-3 space-y-1">{observations.map(row => <li key={row.id}>{row.name}: {formatMoney(row.amount, row.currency, locale)} — {row.date} — {row.provenance}</li>)}</ul>
    {missing.map(account => <p key={account.id} className="mt-2 text-amber-700">{account.name}: {account.balance.warnings.join("; ") || "No dated balance"}</p>)}
    {uncertain.map(account => <p key={account.id} className="mt-2 text-amber-700">{account.name}: Original observation retained; later activity cannot be reconciled. {account.balance.warnings.join("; ")}</p>)}
    {valuations.missingInputs.length > 0 && <p className="mt-2 text-amber-700">{valuations.missingInputs.join("; ")}</p>}
    {valuations.excludedLinked.length > 0 && <p className="mt-2 text-muted-foreground">{valuations.excludedLinked.length} account-linked valuations excluded to avoid counting them twice.</p>}
    <p className="mt-3 text-muted-foreground">Missing statement periods and later unrecorded changes remain unknown. Historical debt principal does not verify current repayment assumptions. Assets and investments do not increase spendable cash.</p>
  </details>;
}
