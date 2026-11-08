import Link from "next/link";
import { NetWorthChart } from "@/app/net-worth-chart";
import { displayFormat } from "@/lib/display-format";
import type { WealthItem } from "@/lib/finance/wealth";
import { PERIODS, toMinor } from "@/lib/scalable/live";
import type { ScalablePortfolio } from "@/lib/scalable/portfolio";

type Point = { date: string; value: bigint };
const signed = (minor: bigint, text: string) => minor > 0n ? `+${text}` : text;
const tone = (minor: bigint) => minor > 0n ? "text-success" : minor < 0n ? "text-danger" : "text-muted-foreground";
const pct = (part: bigint, whole: bigint) => whole > 0n ? Number(part * 10000n / whole) / 100 : null;
const pctText = (value: number | null) => value === null ? "" : `${value > 0 ? "+" : ""}${value.toLocaleString("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
// Distinct steps of the brand colour for the allocation bar; cash is always the muted segment.
const SHADES = ["bg-brand", "bg-brand/75", "bg-brand/55", "bg-brand/40", "bg-brand/25", "bg-amber-500/70"];

/**
 * The Scalable portfolio on Wealth: value with today's move, Scalable's gain or loss per period, the recorded value
 * over time, where the money sits, each position's gain, and the latest activity and watchlist from the last sync.
 */
export function ScalableInvestments({ portfolio, positions, history, calculatedBefore, historyFailed, syncedAt, active, locale, timeZone }: {
  portfolio: ScalablePortfolio; positions: WealthItem[]; history: Point[]; calculatedBefore: string | null; historyFailed: boolean; syncedAt: string | null; active: boolean; locale: string; timeZone: string;
}) {
  const { money, date, dateTime } = displayFormat(locale, timeZone);
  const cur = portfolio.currency, show = (minor: bigint | string) => money(minor, cur);
  const total = BigInt(portfolio.totalMinor);
  const today = portfolio.performance.find(entry => entry.timeframe === "INTRADAY");
  const todayMinor = today ? BigInt(today.returnMinor) : null;
  const periods = Object.entries(PERIODS).filter(([key]) => key !== "INTRADAY").flatMap(([key, label]) => {
    const entry = portfolio.performance.find(item => item.timeframe === key); return entry ? [{ label, minor: BigInt(entry.returnMinor) }] : []; });
  const slices = [...positions.map(item => ({ name: item.name, minor: BigInt(item.amount_minor) })),
    ...(BigInt(portfolio.cryptoMinor) > 0n ? [{ name: "Crypto", minor: BigInt(portfolio.cryptoMinor) }] : [])].sort((a, b) => Number(b.minor - a.minor));
  const cash = BigInt(portfolio.cashMinor);
  // From the first trade this difference is mostly money paid in, not a gain, so it is only shown for synced days.
  const first = calculatedBefore ? undefined : history[0]?.value, change = first === undefined ? null : total - first;

  return <section aria-labelledby="scalable-heading" className="space-y-5 rounded-xl border border-border bg-card p-6">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="scalable-heading" className="text-sm font-medium">Scalable Capital</h2>
      <p className="text-xs text-muted-foreground">{active ? "Synced" : "Login ended, showing the last sync"}{syncedAt ? ` ${dateTime(syncedAt)}` : ""} · <Link href="/import#scalable" className="text-brand hover:underline">Sync or manage</Link></p>
    </div>

    <div>
      <p className="break-words font-mono text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">{show(total)}</p>
      {todayMinor !== null && <p className={`mt-1 font-mono text-sm tabular-nums ${tone(todayMinor)}`}>{signed(todayMinor, show(todayMinor))} {pctText(pct(todayMinor, total - todayMinor))} <span className="font-sans text-muted-foreground">today</span></p>}
    </div>

    {periods.length > 0 && <ul aria-label="Gain or loss by period" className="flex flex-wrap gap-2">{periods.map(period =>
      <li key={period.label} className="rounded-lg border border-border px-3 py-1.5"><span className="block text-xs text-muted-foreground">{period.label}</span>
        <span className={`font-mono text-sm tabular-nums ${tone(period.minor)}`}>{signed(period.minor, show(period.minor))}</span></li>)}</ul>}

    <div>
      {history.length >= 2 ? <>
        <NetWorthChart label={`Scalable portfolio value in ${cur} by day`} points={history.map(point => ({ date: point.date, label: date(point.date), amount: show(point.value), y: Number(point.value) }))} />
        <p className="mt-1 flex justify-between text-xs text-muted-foreground"><span>{date(history[0].date)}</span>
          {change !== null && <span className={tone(change)}>{signed(change, show(change))} since then</span>}<span>Today</span></p>
        {calculatedBefore && <p className="mt-2 text-xs text-muted-foreground">Days before {date(calculatedBefore)} are calculated from your transactions and past prices. Prices further than a year back are monthly, and crypto is estimated.</p>}
      </> : <p className="text-sm text-muted-foreground">The value chart fills in day by day as Moneo syncs Scalable.</p>}
      {historyFailed && <p className="mt-2 text-xs text-muted-foreground">Earlier days could not be worked out, so this chart starts at your first sync.</p>}
    </div>

    {total > 0n && <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        {slices.map((slice, index) => <span key={slice.name} className={SHADES[index % SHADES.length]} style={{ width: `${Number(slice.minor * 10000n / total) / 100}%` }} />)}
        {cash > 0n && <span className="bg-muted-foreground/30" style={{ width: `${Number(cash * 10000n / total) / 100}%` }} />}
      </div>
      <ul aria-label="Where the money is" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {slices.map((slice, index) => <li key={slice.name} className="flex items-center gap-1.5"><span className={`size-2 rounded-full ${SHADES[index % SHADES.length]}`} />{slice.name} {pct(slice.minor, total)?.toFixed(0)}%</li>)}
        {cash > 0n && <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-muted-foreground/30" />Cash {pct(cash, total)?.toFixed(0)}%</li>}
      </ul>
    </div>}

    <div className="divide-y divide-border rounded-lg border border-border">
      {positions.map(item => {
        const value = BigInt(item.amount_minor), gain = item.cost_basis_minor === null ? null : value - BigInt(item.cost_basis_minor);
        return <div key={item.id} className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0"><p className="truncate font-medium">{item.name}</p>
            <p className="text-xs text-muted-foreground">{item.quantity_text} × {item.unit_price_text ? money(toMinor(item.unit_price_text, item.currency_code), item.currency_code) : "—"}</p></div>
          <div className="shrink-0 text-right"><p className="font-mono tabular-nums">{money(value, item.currency_code)}</p>
            {gain !== null && <p className={`font-mono text-xs tabular-nums ${tone(gain)}`}>{signed(gain, money(gain, item.currency_code))} {pctText(pct(gain, BigInt(item.cost_basis_minor!)))}</p>}</div>
        </div>;
      })}
      {BigInt(portfolio.cryptoMinor) > 0n && <div className="flex justify-between gap-3 px-4 py-3"><p className="font-medium">Crypto</p><p className="font-mono tabular-nums">{show(portfolio.cryptoMinor)}</p></div>}
      <div className="flex justify-between gap-3 px-4 py-3"><div><p className="font-medium">Cash to invest</p></div><p className="font-mono tabular-nums">{show(cash)}</p></div>
    </div>

    {(portfolio.activity?.length ?? 0) > 0 && <div>
      <h3 className="text-xs font-medium text-muted-foreground">Recent activity</h3>
      <ul className="mt-2 space-y-1.5 text-sm">{portfolio.activity!.slice(0, 5).map(row => {
        const amount = row.amountMinor === null ? null : BigInt(row.amountMinor);
        return <li key={row.id} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate"><span className="font-mono text-xs text-muted-foreground">{date(row.date)}</span> <span className="capitalize">{row.type}</span>{row.shares ? ` ${row.shares} ×` : ""} <span className="text-muted-foreground">{row.description}</span>{row.status !== "SETTLED" ? <span className="text-xs text-warning"> · {row.status.toLowerCase()}</span> : null}</span>
          {amount !== null && <span className={`shrink-0 font-mono tabular-nums ${amount > 0n ? "text-success" : ""}`}>{signed(amount, money(amount, row.currencyCode))}</span>}</li>;
      })}</ul>
    </div>}

    {(portfolio.watchlist?.length ?? 0) > 0 && <div>
      <h3 className="text-xs font-medium text-muted-foreground">Watchlist</h3>
      <ul className="mt-2 flex flex-wrap gap-2 text-sm">{portfolio.watchlist!.map(item => <li key={item.isin} className="rounded-lg border border-border px-3 py-1.5">
        <span className="block max-w-56 truncate text-xs">{item.name}</span>
        <span className="font-mono tabular-nums">{item.priceMinor ? money(item.priceMinor, item.currencyCode) : "—"}</span>
        {item.dayPercent !== null && <span className={`ml-1.5 font-mono text-xs ${item.dayPercent > 0 ? "text-success" : item.dayPercent < 0 ? "text-danger" : "text-muted-foreground"}`}>{pctText(item.dayPercent)}</span>}</li>)}</ul>
    </div>}
  </section>;
}
