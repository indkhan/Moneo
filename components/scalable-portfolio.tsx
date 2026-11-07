import Link from "next/link";
import { formatMoney } from "@/lib/finance/format";
import type { ScalablePortfolio } from "@/lib/scalable/portfolio";

// Scalable's own returns per timeframe, shortest first; the rest are left out.
const TIMEFRAMES = [["ONE_WEEK", "1 week"], ["ONE_MONTH", "1 month"], ["THREE_MONTHS", "3 months"], ["ONE_YEAR", "1 year"], ["MAX", "All time"]] as const;

/** The synced Scalable portfolio: total, split, and Scalable's own returns. */
export function ScalablePortfolioView({ portfolio, locale }: { portfolio: ScalablePortfolio; locale?: string }) {
  const money = (minor: string) => formatMoney(minor, portfolio.currency, locale);
  const returns = TIMEFRAMES.flatMap(([key, label]) => { const entry = portfolio.performance.find(item => item.timeframe === key); return entry ? [{ label, minor: entry.returnMinor }] : []; });
  return <div className="space-y-3 text-sm">
    <div>
      <p className="text-xs text-muted-foreground">Portfolio value on {portfolio.asOf}</p>
      <p className="font-mono text-2xl font-semibold tabular-nums">{money(portfolio.totalMinor)}</p>
    </div>
    <dl className="grid grid-cols-3 gap-3">
      {([["Securities", portfolio.securitiesMinor], ["Crypto", portfolio.cryptoMinor], ["Cash", portfolio.cashMinor]] as const).map(([label, minor]) =>
        <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-mono tabular-nums">{money(minor)}</dd></div>)}
    </dl>
    {returns.length > 0 && <div>
      <p className="text-xs text-muted-foreground">Gain or loss, as Scalable reports it</p>
      <dl className="mt-1 grid grid-cols-3 gap-3 sm:grid-cols-5">{returns.map(entry => <div key={entry.label}><dt className="text-xs text-muted-foreground">{entry.label}</dt>
        <dd className={`font-mono tabular-nums ${BigInt(entry.minor) < 0n ? "text-danger" : ""}`}>{BigInt(entry.minor) > 0n ? "+" : ""}{money(entry.minor)}</dd></div>)}</dl>
    </div>}
    <p className="text-muted-foreground">Each position, plus cash and crypto, is an investment on <Link href="/money/wealth" className="text-brand underline-offset-4 hover:underline">Wealth</Link> and counts toward net worth. Moneo syncs daily.</p>
  </div>;
}
