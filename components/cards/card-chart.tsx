"use client";

import { useState } from "react";

type Series = { name: string; values: (number | null)[]; color?: string };
export type CardChartProps = { type: "line" | "area" | "bar" | "hbar" | "donut" | "sparkline"; labels: string[]; series: Series[]; stacked?: boolean; axis?: boolean; currency?: string; height?: number; className?: string; style?: React.CSSProperties };

// The app's own chart colours, in order, for series that don't pick one.
const PALETTE = ["var(--color-brand)", "var(--color-ai)", "var(--color-chart-out)", "var(--color-warning)", "var(--color-chart-input)", "var(--color-success)", "var(--color-danger)", "var(--color-muted-foreground)"];
const W = 600;

function format(value: number | null | undefined, currency?: string) {
  if (value === null || value === undefined) return "–";
  return currency ? new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2 }).format(value)
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

/** Charts drawn as SVG by the app from the card's numbers; the card never passes code or HTML to a chart. */
export function CardChart({ type, labels, series, stacked, axis, currency, height, className, style }: CardChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const colors = series.map((item, index) => item.color ?? PALETTE[index % PALETTE.length]);
  const count = Math.max(labels.length, ...series.map(item => item.values.length));
  const tooltip = active !== null && <div role="status" className="pointer-events-none absolute top-0 z-10 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs shadow-lg"
    style={{ left: `clamp(0px, calc(${((active + 0.5) / count) * 100}% - 4rem), calc(100% - 8rem))` }}>
    {labels[active] && <p className="text-muted-foreground">{labels[active]}</p>}
    {series.map((item, index) => <p key={item.name} className="flex items-center gap-1.5 whitespace-nowrap font-mono"><span className="size-2 rounded-full" style={{ background: colors[index] }} />{series.length > 1 && `${item.name} `}{format(item.values[active], currency)}</p>)}
  </div>;

  if (type === "donut") {
    const values = series[0].values.map(value => Math.max(0, value ?? 0));
    const total = values.reduce((sum, value) => sum + value, 0) || 1;
    // Each slice starts where the ones before it end.
    const starts = values.map((_, index) => values.slice(0, index).reduce((sum, value) => sum + (value / total) * 100, 0));
    const size = height ?? 140;
    return <div className={`relative flex items-center gap-4 ${className ?? ""}`} style={style} onPointerLeave={() => setActive(null)}>
      <svg viewBox="0 0 42 42" width={size} height={size} role="img" aria-label={series[0].name} className="shrink-0 -rotate-90">
        <circle cx="21" cy="21" r="15.915" fill="none" stroke="var(--color-muted)" strokeWidth="6" />
        {values.map((value, index) => {
          const share = (value / total) * 100, dash = `${share} ${100 - share}`, start = starts[index];
          return <circle key={index} cx="21" cy="21" r="15.915" fill="none" stroke={PALETTE[index % PALETTE.length]} strokeWidth={active === index ? 7.5 : 6}
            strokeDasharray={dash} strokeDashoffset={-start} onPointerEnter={() => setActive(index)} className="transition-[stroke-width]" />;
        })}
      </svg>
      <ul className="min-w-0 flex-1 space-y-1 text-xs">{values.map((value, index) => <li key={index} onPointerEnter={() => setActive(index)} className={`flex items-center gap-2 ${active === null || active === index ? "" : "opacity-50"}`}>
        <span className="size-2 shrink-0 rounded-full" style={{ background: PALETTE[index % PALETTE.length] }} /><span className="min-w-0 flex-1 truncate">{labels[index]}</span><span className="font-mono">{format(value, currency)}</span></li>)}</ul>
    </div>;
  }

  if (type === "hbar") {
    const values = series[0].values;
    const max = Math.max(...values.map(value => Math.abs(value ?? 0)), 1);
    return <ul className={`space-y-2 text-sm ${className ?? ""}`} style={style}>{values.map((value, index) => <li key={index}>
      <div className="flex justify-between gap-3"><span className="truncate">{labels[index]}</span><span className="shrink-0 font-mono text-xs">{format(value, currency)}</span></div>
      <div className="mt-1 h-1.5 rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${(Math.abs(value ?? 0) / max) * 100}%`, background: colors[0] }} /></div>
    </li>)}</ul>;
  }

  const h = height ?? (type === "sparkline" ? 40 : 140);
  const totals = Array.from({ length: count }, (_, index) => series.reduce((sum, item) => sum + Math.max(0, item.values[index] ?? 0), 0));
  const all = stacked && type === "bar" ? totals : series.flatMap(item => item.values.filter((value): value is number => value !== null));
  const min = type === "bar" ? Math.min(0, ...all) : Math.min(...all), max = Math.max(...all, min + 1);
  const y = (value: number) => h - 2 - ((value - min) / (max - min)) * (h - 4);
  const x = (index: number) => count === 1 ? W / 2 : (index / (count - 1)) * W;
  const band = W / Math.max(count, 1);
  const pick = (event: React.PointerEvent<HTMLDivElement>) => { const rect = event.currentTarget.getBoundingClientRect(); setActive(Math.max(0, Math.min(count - 1, Math.floor(((event.clientX - rect.left) / rect.width) * count)))); };
  return <div className={className} style={style}>
    <div className="relative" onPointerMove={type === "sparkline" ? undefined : pick} onPointerLeave={() => setActive(null)}>
      <svg viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" role="img" aria-label={series.map(item => item.name).join(", ")} className="block w-full overflow-visible" style={{ height: h }}>
        {type === "bar" ? series.map((item, seriesIndex) => item.values.map((value, index) => {
          if (value === null) return null;
          const below = stacked ? series.slice(0, seriesIndex).reduce((sum, other) => sum + Math.max(0, other.values[index] ?? 0), 0) : 0;
          const width = stacked ? band * 0.62 : (band * 0.62) / series.length;
          const left = index * band + band * 0.19 + (stacked ? 0 : seriesIndex * width);
          const top = y(below + Math.max(0, value)), bottom = y(below + Math.min(0, value));
          return <rect key={`${seriesIndex}-${index}`} x={left} y={top} width={width} height={Math.max(1, bottom - top)} rx={2} fill={colors[seriesIndex]} opacity={active === null || active === index ? 1 : 0.45} />;
        })) : series.map((item, seriesIndex) => {
          const points = item.values.map((value, index) => value === null ? null : `${x(index).toFixed(1)},${y(value).toFixed(1)}`).filter(Boolean).join(" ");
          return <g key={item.name}>
            {type === "area" && <polygon points={`${x(0)},${h} ${points} ${x(item.values.length - 1)},${h}`} fill={colors[seriesIndex]} opacity={0.15} />}
            <polyline points={points} fill="none" stroke={colors[seriesIndex]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </g>;
        })}
        {active !== null && type !== "bar" && <line x1={x(active)} x2={x(active)} y1={0} y2={h} stroke="var(--color-muted-foreground)" strokeOpacity={0.5} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      </svg>
      {tooltip}
    </div>
    {axis !== false && type !== "sparkline" && labels.length > 1 && <p className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground"><span>{labels[0]}</span>{labels.length > 2 && <span>{labels[Math.floor((labels.length - 1) / 2)]}</span>}<span>{labels.at(-1)}</span></p>}
  </div>;
}
