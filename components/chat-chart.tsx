import Link from "next/link";
import { formatMoney } from "@/lib/finance/format";
import { z } from "zod";

// Older answers carry app-written ```moneo-chart blocks; they keep rendering.
const answerChartSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  rows: z.array(z.object({
    label: z.string().min(1).max(240),
    valueMinor: z.string().regex(/^-?(?:0|[1-9]\d{0,79})$/),
    href: z.string().max(500).regex(/^\/money\/transactions\?[\w=&%.-]*$/).optional(),
  }).strict()).min(2).max(20),
}).strict();

/** Inline bars for an app-written `moneo-chart` block; exact amounts stay as text beside each bar. */
export function ChatChart({ source }: { source: string }) {
  let parsed;
  try { parsed = answerChartSchema.safeParse(JSON.parse(source)); } catch { return null; }
  if (!parsed.success) return null;
  const { currency, rows } = parsed.data;
  const abs = (value: string) => { const minor = BigInt(value); return minor < 0n ? -minor : minor; };
  const max = rows.reduce((largest, row) => abs(row.valueMinor) > largest ? abs(row.valueMinor) : largest, 0n) || 1n;
  return <figure className="ai-chart my-4 min-w-0 max-w-full rounded-xl border border-border bg-card p-4" aria-label={`Chart of measured amounts in ${currency}`}>
    <ul className="space-y-2.5">{rows.map(row => {
      const width = Number((abs(row.valueMinor) * 1000n) / max) / 10;
      const label = row.href ? <Link href={row.href} className="hover:underline" title="Open matching transactions">{row.label}</Link> : row.label;
      return <li key={row.label} className="grid grid-cols-[minmax(0,1fr)] gap-1 text-sm">
        <div className="flex items-baseline justify-between gap-3"><span className="min-w-0 [overflow-wrap:anywhere]">{label}</span><span className="shrink-0 font-medium tabular-nums">{formatMoney(row.valueMinor, currency)}</span></div>
        <div className="h-2 rounded-full bg-muted" aria-hidden="true"><div className={`h-2 rounded-full ${BigInt(row.valueMinor) < 0n ? "bg-red-500/70" : "bg-primary"}`} style={{ width: `${Math.max(width, 1)}%` }} /></div>
      </li>;
    })}</ul>
    <figcaption className="mt-3 text-xs text-muted-foreground">Bars compare verified measures above. Select a label to open the matching transactions.</figcaption>
  </figure>;
}
