"use client";
import { ScalablePositionChart } from "@/components/scalable-position-chart";
import { DeltaText, TONE, ValueHistory } from "@/components/scalable-value-history";
import type { HoldingView } from "@/lib/scalable/holding-view";

const heading = "text-xs font-medium text-muted-foreground";
const cell = "px-2 py-2 text-right font-mono tabular-nums";

export function ScalableHoldingDetail({ view }: { view: HoldingView }) {
  return <div className="@container space-y-6">
    <dl className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @3xl:grid-cols-4">
      {view.facts.map(fact => <div key={fact.label}><dt className="text-xs text-muted-foreground">{fact.label}</dt>
        <dd className={`break-words font-mono text-sm tabular-nums ${fact.direction ? TONE[fact.direction] : ""}`}>{fact.value}</dd></div>)}
      {view.isin && <div><dt className="text-xs text-muted-foreground">ISIN</dt><dd className="font-mono text-sm">{view.isin}</dd></div>}
    </dl>

    <section className="space-y-3">
      <h4 className={heading}>Value of your holding</h4>
      {view.historyNote && <p className="text-xs text-warning">{view.historyNote}</p>}
      <ValueHistory view={view.history} label={`${view.name} value by day`} />
    </section>

    <section className="space-y-3">
      <h4 className={heading}>Price</h4>
      <ScalablePositionChart name={view.name} views={view.prices} />
      {view.periods.length > 0 && <table className="w-full text-sm">
        <caption className="sr-only">Price change of {view.name} by period</caption>
        <thead className="text-xs text-muted-foreground"><tr className="border-b border-border">
          <th scope="col" className="py-2 pr-2 text-left font-medium">Period</th><th scope="col" className="px-2 py-2 text-right font-medium">Price then</th><th scope="col" className="py-2 pl-2 text-right font-medium">Change</th>
        </tr></thead>
        <tbody>{view.periods.map(row => <tr key={row.label} className="border-b border-border align-top last:border-0">
          <th scope="row" className="py-2 pr-2 text-left font-normal">{row.label}<span className="block text-xs text-muted-foreground">from {row.from}</span></th>
          <td className={cell}>{row.then}<span className="block text-xs text-muted-foreground">now {row.now}</span></td>
          <td className={`py-2 pl-2 text-right font-mono tabular-nums ${TONE[row.change.direction]}`}>{row.change.percent ?? "—"}<DeltaText delta={{ ...row.change, percent: null }} /></td>
        </tr>)}</tbody>
      </table>}
    </section>

    <section className="space-y-2">
      <h4 className={heading}>Your trades</h4>
      {view.trades.length ? <ul aria-label={`Trades of ${view.name}`} className="max-h-72 divide-y divide-border overflow-auto rounded-lg border border-border text-sm">
        {view.trades.map((trade, order) => <li key={order} className="flex items-start justify-between gap-3 px-3 py-2">
          <span>{trade.side} {trade.quantity}<span className="block text-xs text-muted-foreground">{trade.when}</span></span>
          <span className="text-right font-mono tabular-nums">{trade.amount ?? "—"}<span className="block text-xs text-muted-foreground">{trade.price ? `at ${trade.price}` : "price not stored"}</span></span>
        </li>)}
      </ul> : <p className="text-sm text-muted-foreground">No trades of this holding are stored.</p>}
      {view.trades.some(trade => trade.amount) && <p className="text-xs text-muted-foreground">Amounts are shares × price, without fees or taxes.</p>}
    </section>
  </div>;
}
