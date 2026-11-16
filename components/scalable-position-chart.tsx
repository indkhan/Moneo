"use client";
import { useState } from "react";
import { NetWorthChart } from "@/components/net-worth-chart";
import type { PositionChartView } from "@/lib/scalable/chart-view";

const DEFAULT_PERIOD = "one_month";
const TONE = { up: "text-success", down: "text-danger", flat: "text-muted-foreground" };

export function ScalablePositionChart({ name, views }: { name: string; views: PositionChartView }) {
  const [key, setKey] = useState(() => views.find(view => view.key === DEFAULT_PERIOD)?.key ?? views[0]?.key);
  const view = views.find(entry => entry.key === key);
  if (!view) return <p className="text-sm text-muted-foreground">No price chart is stored yet. It appears after the next Scalable sync.</p>;
  return <div className="space-y-3">
    <div role="group" aria-label="Chart period" className="flex gap-1.5">{views.map(entry =>
      <button key={entry.key} type="button" aria-pressed={entry.key === view.key} onClick={() => setKey(entry.key)}
        className={`min-h-11 min-w-11 rounded-lg border px-3 text-sm ${entry.key === view.key ? "border-brand bg-brand/10 font-medium text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}>{entry.label}</button>)}</div>
    {view.change && <p className={`font-mono text-sm tabular-nums ${TONE[view.change.direction]}`}>{view.change.text} <span className="font-sans text-muted-foreground">over {view.label}</span></p>}
    <NetWorthChart label={`${name} price, ${view.label}`} points={view.points} markers={view.markers} />
    {view.markers.length > 0 && <ul aria-label="Your trades in this period" className="space-y-0.5 text-xs text-muted-foreground">{view.markers.map((marker, order) =>
      <li key={order} className="flex items-center gap-1.5"><span aria-hidden="true" className={`size-2 rounded-full ${marker.side === "BUY" ? "bg-success" : "bg-danger"}`} />{marker.label}</li>)}</ul>}
    <p className="text-xs text-muted-foreground">As of {view.asOf}, from the last Scalable sync.</p>
  </div>;
}
