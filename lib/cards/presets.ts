import { z } from "zod";

/**
 * Six card shapes we wrote ourselves. The model picks one and fills its settings; values are paths into the
 * card's data (e.g. "month.spending_formatted" or "byCategory.rows"), so amounts always come from the app.
 * They render through the same pipeline as designed cards, from trusted source.
 */
const path = z.string().regex(/^[a-zA-Z_][\w]*(\.[\w]+)*$/).max(200);
const field = z.string().regex(/^[\w]+(\.[\w]+)*$/).max(100);
const tone = z.enum(["positive", "negative", "neutral"]).optional();
const text = z.string().max(120);

export const PRESETS = {
  stat: { description: "One big figure with a label and an optional note line, e.g. spent this month.",
    config: z.object({ label: text, value: path, note: path.optional(), noteText: text.optional(), tone }).strict() },
  stat_row: { description: "Two to four figures side by side, e.g. income / spending / net.",
    config: z.object({ items: z.array(z.object({ label: text, value: path, tone }).strict()).min(2).max(4) }).strict() },
  bar_list: { description: "A ranked list with a bar per row, e.g. spending by category or top merchants.",
    config: z.object({ rows: path, label: field, value: field, amount: field, limit: z.number().int().min(1).max(12).default(5), headline: path.optional() }).strict() },
  trend: { description: "A headline figure over a line, area or bar chart of a series, e.g. monthly spending.",
    config: z.object({ rows: path, label: field, amount: field, kind: z.enum(["line", "area", "bar"]).default("area"), headline: path.optional(), caption: text.optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).strict() },
  progress: { description: "Progress bars toward targets, e.g. savings goals or budgets.",
    config: z.object({ rows: path, label: field, current: field, target: field, note: field.optional(), limit: z.number().int().min(1).max(6).default(3) }).strict() },
  list: { description: "A compact list of items with a trailing value, e.g. upcoming bills or recent transactions.",
    config: z.object({ rows: path, primary: field, secondary: field.optional(), trailing: field, limit: z.number().int().min(1).max(8).default(4) }).strict() },
} as const;
export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as [PresetName, ...PresetName[]];
export const PRESET_GUIDE = PRESET_NAMES.map(name => `- ${name}: ${PRESETS[name].description}`).join("\n");

const HELPERS = `
const get = (from: any, path?: string) => path ? path.split(".").reduce((value, key) => value == null ? undefined : value[key], from) : undefined;
const show = (value: any) => value == null ? "–" : typeof value === "object" ? (value.formatted ?? value.valueFormatted ?? JSON.stringify(value)) : String(value);
const num = (value: any) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const toneColor = (tone?: string) => tone === "positive" ? "var(--color-success)" : tone === "negative" ? "var(--color-danger)" : undefined;
const big = "font-display text-4xl font-semibold tracking-tight tabular-nums";
const rowsOf = (data: any, path: string) => { const rows = get(data, path); return Array.isArray(rows) ? rows : []; };
`;

const TEMPLATES: Record<PresetName, string> = {
  stat: `export default function Card({ data }) {
  return <div className="flex h-full flex-col justify-center gap-1">
    <p className="eyebrow">{config.label}</p>
    <p className={big} style={{ color: toneColor(config.tone) }}>{show(get(data, config.value))}</p>
    {(config.note || config.noteText) && <p className="text-sm text-muted-foreground">{config.note ? show(get(data, config.note)) : config.noteText}</p>}
  </div>;
}`,
  stat_row: `export default function Card({ data, size }) {
  return <div className="grid h-full content-center gap-4" style={{ gridTemplateColumns: \`repeat(\${size === "S" ? 1 : config.items.length}, minmax(0, 1fr))\` }}>
    {config.items.map(item => <div key={item.label} className="min-w-0">
      <p className="eyebrow">{item.label}</p>
      <p className="truncate text-2xl font-semibold tabular-nums" style={{ color: toneColor(item.tone) }}>{show(get(data, item.value))}</p>
    </div>)}
  </div>;
}`,
  bar_list: `export default function Card({ data, size }) {
  const rows = rowsOf(data, config.rows).slice(0, size === "S" ? Math.min(config.limit, 4) : config.limit);
  const max = Math.max(1, ...rows.map(row => Math.abs(num(get(row, config.amount)))));
  return <div className="flex h-full flex-col gap-2">
    {config.headline && <p className="text-2xl font-semibold tabular-nums">{show(get(data, config.headline))}</p>}
    {!rows.length && <p className="text-sm text-muted-foreground">Nothing to show yet.</p>}
    <ul className="space-y-2">{rows.map((row, index) => <li key={index}>
      <div className="flex justify-between gap-3 text-sm"><span className="truncate">{show(get(row, config.label))}</span><span className="shrink-0 font-mono text-xs">{show(get(row, config.value))}</span></div>
      <div className="mt-1 h-1.5 rounded-full bg-muted"><div className="h-full rounded-full bg-brand" style={{ width: (Math.abs(num(get(row, config.amount))) / max * 100) + "%" }} /></div>
    </li>)}</ul>
  </div>;
}`,
  trend: `export default function Card({ data }) {
  const rows = rowsOf(data, config.rows);
  return <div className="flex h-full flex-col justify-end gap-2">
    {config.headline && <p className="text-3xl font-semibold tabular-nums">{show(get(data, config.headline))}</p>}
    {config.caption && <p className="text-xs text-muted-foreground">{config.caption}</p>}
    {rows.length ? <Kit.Chart type={config.kind} height={config.headline ? 110 : 160} currency={config.currency} labels={rows.map(row => String(show(get(row, config.label))))} series={[{ name: config.caption ?? "Value", values: rows.map(row => num(get(row, config.amount))) }]} />
      : <p className="text-sm text-muted-foreground">Nothing to show yet.</p>}
  </div>;
}`,
  progress: `export default function Card({ data }) {
  const rows = rowsOf(data, config.rows).slice(0, config.limit);
  return <ul className="flex h-full flex-col justify-center gap-4">
    {!rows.length && <li className="text-sm text-muted-foreground">Nothing to show yet.</li>}
    {rows.map((row, index) => { const share = Math.min(100, Math.max(0, num(get(row, config.current)) / Math.max(1, num(get(row, config.target))) * 100)); return <li key={index}>
      <div className="flex justify-between gap-3 text-sm"><span className="truncate font-medium">{show(get(row, config.label))}</span><span className="shrink-0 font-mono text-xs">{Math.round(share)}%</span></div>
      <div className="mt-1.5 h-2 rounded-full bg-muted"><div className="h-full rounded-full bg-brand" style={{ width: share + "%" }} /></div>
      {config.note && <p className="mt-1 text-xs text-muted-foreground">{show(get(row, config.note))}</p>}
    </li>; })}
  </ul>;
}`,
  list: `export default function Card({ data, size }) {
  const rows = rowsOf(data, config.rows).slice(0, config.limit);
  return <ul className="divide-y divide-border">
    {!rows.length && <li className="py-2 text-sm text-muted-foreground">Nothing to show yet.</li>}
    {rows.map((row, index) => <li key={index} className="flex items-center justify-between gap-3 py-2">
      <span className="min-w-0"><span className="block truncate text-sm">{show(get(row, config.primary))}</span>{config.secondary && size !== "S" && <span className="block truncate text-xs text-muted-foreground">{show(get(row, config.secondary))}</span>}</span>
      <span className="shrink-0 font-mono text-xs">{show(get(row, config.trailing))}</span>
    </li>)}
  </ul>;
}`,
};

/** The card source for a preset: the settings, our helpers and the template. */
export function presetSource(preset: PresetName, config: unknown) {
  const parsed = PRESETS[preset].config.parse(config);
  return `const config = ${JSON.stringify(parsed)};\n${HELPERS}\n${TEMPLATES[preset]}\n`;
}
