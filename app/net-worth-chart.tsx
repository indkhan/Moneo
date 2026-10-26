"use client";
import { useId, useState } from "react";

// Points carry their exact formatted amount from the server; `y` is only used for pixel scale.
export type NetWorthPoint = { date: string; label: string; amount: string; y: number };

const WIDTH = 640, HEIGHT = 140, PAD = 6;

/** Net worth over time; hovering (or tapping) shows the exact amount and date at that point. */
export function NetWorthChart({ points, label }: { points: NetWorthPoint[]; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const gradient = useId();
  const values = points.map(point => point.y);
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const x = (index: number) => points.length === 1 ? WIDTH / 2 : (index / (points.length - 1)) * WIDTH;
  const y = (value: number) => HEIGHT - PAD - ((value - min) / span) * (HEIGHT - PAD * 2);
  const line = points.map((point, index) => `${x(index).toFixed(1)},${y(point.y).toFixed(1)}`).join(" ");
  const pick = (clientX: number, rect: DOMRect) => setActive(Math.max(0, Math.min(points.length - 1, Math.round(((clientX - rect.left) / rect.width) * (points.length - 1)))));
  const shown = active === null ? null : points[active];
  return <div className="relative" onPointerLeave={() => setActive(null)}>
    <svg role="img" aria-label={label} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="h-[140px] w-full cursor-crosshair touch-none overflow-visible text-brand"
      onPointerMove={event => pick(event.clientX, event.currentTarget.getBoundingClientRect())} onPointerDown={event => pick(event.clientX, event.currentTarget.getBoundingClientRect())}>
      <defs><linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="currentColor" stopOpacity={0.22} /><stop offset="100%" stopColor="currentColor" stopOpacity={0} /></linearGradient></defs>
      <polygon points={`0,${HEIGHT} ${line} ${WIDTH},${HEIGHT}`} fill={`url(#${gradient})`} />
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {active !== null && <line x1={x(active)} x2={x(active)} y1={0} y2={HEIGHT} stroke="var(--color-muted-foreground)" strokeOpacity={0.5} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
    </svg>
    {shown && <>
      <span aria-hidden="true" className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-brand shadow"
        style={{ left: `${(x(active!) / WIDTH) * 100}%`, top: `${(y(shown.y) / HEIGHT) * 100}%` }} />
      <div role="status" className="pointer-events-none absolute -top-2 z-10 -translate-y-full rounded-lg border border-border bg-card px-3 py-2 shadow-lg"
        style={{ left: `clamp(0px, calc(${(x(active!) / WIDTH) * 100}% - 4.5rem), calc(100% - 9rem))` }}>
        <p className="whitespace-nowrap font-mono text-sm font-semibold">{shown.amount}</p>
        <p className="whitespace-nowrap text-[11px] text-muted-foreground">{shown.label}</p>
      </div>
    </>}
  </div>;
}
