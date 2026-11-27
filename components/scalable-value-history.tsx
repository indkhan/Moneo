"use client";
import { useState } from "react";
import { NetWorthChart } from "@/components/net-worth-chart";
import type { Delta } from "@/lib/scalable/delta";
import type { ValueHistoryView } from "@/lib/scalable/value-history";

export const TONE = { up: "text-success", down: "text-danger", flat: "text-muted-foreground" };
export const period = (active: boolean) => `min-h-11 min-w-11 rounded-lg border px-3 text-sm ${active ? "border-brand bg-brand/10 font-medium text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`;

export function DeltaText({ delta }: { delta: Delta | null }) {
  return delta ? <span className={`block text-xs ${TONE[delta.direction]}`}>{delta.amount}{delta.percent ? ` (${delta.percent})` : ""}</span> : null;
}

export function ValueHistory({ view, label }: { view: ValueHistoryView; label: string }) {
  const [by, setBy] = useState<"days" | "months">("days");
  const first = view.points[0], last = view.points.at(-1);
  const rows = view[by];
  const priced = rows.some(row => row.price !== null);
  if (!first || !last) return <p className="text-sm text-muted-foreground">No values are stored yet. They appear after a Scalable sync.</p>;
  return <div className="space-y-3">
    {view.points.length > 1
      ? <div><NetWorthChart label={label} points={view.points} byDate /><p className="flex justify-between gap-3 text-xs text-muted-foreground"><span>{first.label}</span><span>{last.label}</span></p></div>
      : <p className="text-sm text-muted-foreground">Only {first.label} is stored so far. The line appears once a second day has synced.</p>}
    {view.calculatedBefore && <p className="text-xs text-muted-foreground">Values before {view.calculatedBefore}, marked *, are calculated from your transactions and Scalable’s past prices. Older prices are further apart.</p>}
    <div role="group" aria-label="Table rows" className="flex gap-1.5">{([["days", "Days"], ["months", "Months"]] as const).map(([key, text]) =>
      <button key={key} type="button" aria-pressed={by === key} onClick={() => setBy(key)} className={period(by === key)}>{text}</button>)}</div>
    <div tabIndex={0} role="region" aria-label={`${label}, table`} className="max-h-80 overflow-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card text-xs text-muted-foreground"><tr className="border-b border-border">
          <th scope="col" className="px-3 py-2 text-left font-medium">Date</th>
          {priced && <th scope="col" className="px-2 py-2 text-right font-medium">Price</th>}
          <th scope="col" className="px-3 py-2 text-right font-medium">Value</th>
        </tr></thead>
        <tbody>{rows.map(row => <tr key={row.date} className="border-b border-border align-top last:border-0">
          <th scope="row" className="px-3 py-2 text-left font-normal">{row.label}{row.calculated ? " *" : ""}
            {row.shares !== null && <span className="block text-xs text-muted-foreground">{row.shares} shares</span>}
            {row.trades && <span className="block text-xs text-brand">{row.trades}</span>}</th>
          {priced && <td className="px-2 py-2 text-right font-mono tabular-nums">{row.price ?? "—"}{row.priceChange?.percent && <span className={`block text-xs ${TONE[row.priceChange.direction]}`}>{row.priceChange.percent}</span>}</td>}
          <td className="px-3 py-2 text-right font-mono tabular-nums">{row.value}{priced ? row.change && <span className={`block text-xs ${TONE[row.change.direction]}`}>{row.change.amount}</span> : <DeltaText delta={row.change} />}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="text-xs text-muted-foreground">Each change compares with the row below it, and includes money moved in or out.{by === "days" ? " Showing up to the last 30 stored days." : " Each month shows its last stored day."}</p>
  </div>;
}
