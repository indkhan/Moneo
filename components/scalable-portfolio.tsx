import Link from "next/link";
import { ScalableHoldings, type HoldingRow } from "@/components/scalable-holdings";
import { displayFormat } from "@/lib/display-format";
import type { ScalablePortfolio } from "@/lib/scalable/portfolio";

const TIMEFRAMES = [["INTRADAY", "Latest market day"], ["ONE_WEEK", "1 week"], ["ONE_MONTH", "1 month"], ["THREE_MONTHS", "3 months"], ["YEAR_TO_DATE", "This year"], ["ONE_YEAR", "1 year"], ["MAX", "All time"]] as const;

export function ScalablePortfolioView({ portfolio, holdings, version, locale, timeZone }: { portfolio: ScalablePortfolio; holdings: HoldingRow[]; version: string; locale: string; timeZone: string }) {
  const format = displayFormat(locale, timeZone);
  const money = (minor: string) => format.money(minor, portfolio.currency);
  const returns = TIMEFRAMES.flatMap(([key, label]) => { const entry = portfolio.performance.find(item => item.timeframe === key); return entry ? [{ label, minor: entry.returnMinor }] : []; });
  return <div className="space-y-3 text-sm">
    <div>
      <p className="text-xs text-muted-foreground">Portfolio value on {format.date(portfolio.asOf)}</p>
      <p className="font-mono text-2xl font-semibold tabular-nums">{money(portfolio.totalMinor)}</p>
    </div>
    <dl className="grid grid-cols-3 gap-3">
      {([["Securities", portfolio.securitiesMinor], ["Crypto", portfolio.cryptoMinor], ["Cash", portfolio.cashMinor]] as const).map(([label, minor]) =>
        <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-mono tabular-nums">{money(minor)}</dd></div>)}
    </dl>
    {returns.length > 0 && <div>
      <p className="text-xs text-muted-foreground">Gain or loss</p>
      <dl className="mt-1 grid grid-cols-3 gap-3 sm:grid-cols-7">{returns.map(entry => <div key={entry.label}><dt className="text-xs text-muted-foreground">{entry.label}</dt>
        <dd className={`font-mono tabular-nums ${BigInt(entry.minor) < 0n ? "text-danger" : BigInt(entry.minor) > 0n ? "text-success" : ""}`}>{BigInt(entry.minor) > 0n ? "+" : ""}{money(entry.minor)}</dd></div>)}</dl>
    </div>}
    <ScalableHoldings holdings={holdings} version={version} />
    <Link href="/money/wealth" className="inline-block text-brand underline-offset-4 hover:underline">See news and activity on Wealth</Link>
  </div>;
}
