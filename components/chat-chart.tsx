"use client";

import Link from "next/link";
import { z } from "zod";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import { ReactECharts, useThemeColors } from "./chart";

// Model-written charts can only use these fields, so no code or styling reaches the page.
const amount = z.string().regex(/^-?(?:0|[1-9]\d{0,79})$/);
const text = z.string().trim().min(1).max(60);
const unit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("money"), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
  z.object({ kind: z.literal("count") }).strict(),
]);
const href = z.string().max(500).regex(/^\/money\/transactions\?[\w=&%.-]*$/).optional();
const header = { title: z.string().trim().min(1).max(80), unit };
const cartesian = z.object({
  ...header,
  type: z.enum(["bar", "line", "area"]),
  horizontal: z.boolean().optional(),
  stacked: z.boolean().optional(),
  labels: z.array(text).min(2).max(24),
  series: z.array(z.object({ name: text, values: z.array(amount).min(1).max(24) }).strict()).min(1).max(4),
}).strict().refine(chart => chart.series.every(series => series.values.length === chart.labels.length), "Each series needs one value per label");
const circular = z.object({
  ...header,
  type: z.enum(["pie", "donut", "treemap", "bubble"]),
  items: z.array(z.object({ label: text, value: amount, href }).strict()).min(2).max(20),
}).strict().refine(chart => chart.items.every(item => !item.value.startsWith("-")), "Values must not be negative");
const chartSchema = z.union([cartesian, circular]);
type ChartSpec = z.infer<typeof chartSchema>;
type CartesianSpec = z.infer<typeof cartesian>;
type CircularSpec = z.infer<typeof circular>;
type ChartUnit = ChartSpec["unit"];

// Same family as the app's charts. Each series or item keeps its colour in the chart and in its table row.
const PALETTE = ["#5266eb", "#9cb4e8", "#f0806c", "#7a8699", "#4fb3bf", "#d9a93a", "#9b87f5", "#a6cf3f", "#d16ba5", "#5c9e31", "#b5651d", "#2a6fdb"];
const GAP = 3;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

function formatAmount(value: string, chartUnit: ChartUnit) {
  return chartUnit.kind === "money" ? formatMoney(value, chartUnit.currency) : BigInt(value).toLocaleString("en-US");
}
// Plotting uses major units for scale only; every number a reader sees comes from formatAmount.
function plotValue(value: string, chartUnit: ChartUnit) {
  return chartUnit.kind === "money" ? Number(value) / 10 ** minorDigits(chartUnit.currency) : Number(value);
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

/** Circles that never overlap; each one goes to the nearest free spot on a spiral out from the centre. */
function packCircles(radii: number[]) {
  const placed: { x: number; y: number; r: number }[] = [];
  for (const r of radii) {
    const clear = (x: number, y: number) => placed.every(other => Math.hypot(x - other.x, y - other.y) >= r + other.r + GAP);
    let angle = 0, x = 0, y = 0;
    while (placed.length && !clear(x, y)) {
      angle += 0.05;
      const distance = angle * 3;
      x = distance * Math.cos(angle);
      y = distance * Math.sin(angle);
    }
    placed.push({ x, y, r });
  }
  return placed;
}

function ChartTable({ chart }: { chart: ChartSpec }) {
  if ("labels" in chart) return <div className="mt-3 overflow-x-auto"><table className="w-full text-sm tabular-nums">
    <thead className="text-xs text-muted-foreground"><tr><th className="py-1 text-left font-normal" />{chart.series.map((series, col) => <th key={col} className="py-1 text-right font-normal"><span className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ background: PALETTE[col % PALETTE.length] }} aria-hidden="true" />{series.name}</th>)}</tr></thead>
    <tbody>{chart.labels.map((label, row) => <tr key={row} className="border-t border-border">
      <th scope="row" className="py-1.5 pr-3 text-left font-normal [overflow-wrap:anywhere]">{label}</th>
      {chart.series.map((series, col) => <td key={col} className="py-1.5 text-right">{formatAmount(series.values[row], chart.unit)}</td>)}
    </tr>)}</tbody>
  </table></div>;
  const total = chart.items.reduce((sum, item) => sum + BigInt(item.value), 0n);
  return <div className="mt-3 overflow-x-auto"><table className="w-full text-sm tabular-nums">
    <thead className="text-xs text-muted-foreground"><tr><th className="py-1 text-left font-normal">Item</th><th className="py-1 text-right font-normal">Amount</th><th className="py-1 text-right font-normal">Share</th></tr></thead>
    <tbody>{chart.items.map((item, index) => <tr key={index} className="border-t border-border">
      <th scope="row" className="py-1.5 pr-3 text-left font-normal [overflow-wrap:anywhere]"><span className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ background: PALETTE[index % PALETTE.length] }} aria-hidden="true" />{item.href ? <Link href={item.href} className="hover:underline" title="Open matching transactions">{item.label}</Link> : item.label}</th>
      <td className="py-1.5 text-right">{formatAmount(item.value, chart.unit)}</td>
      <td className="py-1.5 text-right text-muted-foreground">{total ? percent.format(Number(item.value) / Number(total)) : "0%"}</td>
    </tr>)}</tbody>
    <tfoot><tr className="border-t border-border font-medium"><th scope="row" className="py-1.5 pr-3 text-left font-medium">Total</th><td className="py-1.5 text-right">{formatAmount(total.toString(), chart.unit)}</td><td className="py-1.5 text-right">100%</td></tr></tfoot>
  </table></div>;
}

function CartesianChart({ chart }: { chart: CartesianSpec }) {
  const colors = useThemeColors();
  const { type, unit, labels, series } = chart;
  const horizontal = type === "bar" && chart.horizontal === true;
  const axisLabel = { color: colors.muted };
  const categories = { type: "category", data: labels, inverse: horizontal, axisLine: { lineStyle: { color: colors.border } }, axisTick: { show: false }, axisLabel: { ...axisLabel, hideOverlap: true } };
  const values = { type: "value", name: unit.kind === "money" ? unit.currency : undefined, nameTextStyle: axisLabel, axisLabel: { ...axisLabel, formatter: (value: number) => compact.format(value) }, splitLine: { lineStyle: { color: colors.border, type: "dashed" } } };
  return <ReactECharts notMerge style={{ height: 260 }} option={{
    color: PALETTE,
    grid: { left: 8, right: 12, top: series.length > 1 ? 32 : 12, bottom: 8, containLabel: true },
    legend: series.length > 1 ? { top: 0, textStyle: axisLabel } : undefined,
    tooltip: { trigger: "axis", formatter: (items: { axisValueLabel: string; seriesIndex: number; dataIndex: number; seriesName: string; color: string }[]) => [escapeHtml(items[0]?.axisValueLabel ?? ""), ...items.map(item => `<span style="color:${item.color}">●</span> ${escapeHtml(item.seriesName)}: ${formatAmount(series[item.seriesIndex].values[item.dataIndex], unit)}`)].join("<br/>") },
    xAxis: horizontal ? values : categories,
    yAxis: horizontal ? categories : values,
    series: series.map(item => ({
      name: item.name,
      type: type === "bar" ? "bar" : "line",
      data: item.values.map(value => plotValue(value, unit)),
      stack: chart.stacked ? "total" : undefined,
      barMaxWidth: 36,
      smooth: type !== "bar",
      symbol: "none",
      areaStyle: type === "area" ? { opacity: 0.18 } : undefined,
    })),
  }} />;
}

function CircularChart({ chart }: { chart: CircularSpec }) {
  const colors = useThemeColors();
  const { type, unit, items } = chart;
  const values = items.map(item => Number(item.value));
  const total = items.reduce((sum, item) => sum + BigInt(item.value), 0n);
  if (type === "bubble") {
    // Circle area is proportional to amount, so the biggest item sets the scale.
    const largest = Math.max(...values) || 1;
    const order = items.map((_, index) => index).sort((a, b) => values[b] - values[a]);
    const circles = packCircles(order.map(index => Math.max(3, 100 * Math.sqrt(values[index] / largest))));
    const minX = Math.min(...circles.map(c => c.x - c.r)) - 4, minY = Math.min(...circles.map(c => c.y - c.r)) - 4;
    const maxX = Math.max(...circles.map(c => c.x + c.r)) + 4, maxY = Math.max(...circles.map(c => c.y + c.r)) + 4;
    return <svg role="img" aria-label={chart.title} viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} className="mx-auto h-64 w-full">
      {order.map((index, slot) => <circle key={index} cx={circles[slot].x} cy={circles[slot].y} r={circles[slot].r} fill={PALETTE[index % PALETTE.length]} fillOpacity={0.9}>
        <title>{`${items[index].label}: ${formatAmount(items[index].value, unit)}`}</title>
      </circle>)}
    </svg>;
  }
  const describe = (index: number) => `${escapeHtml(items[index].label)}: ${formatAmount(items[index].value, unit)} (${percent.format(values[index] / Number(total || 1n))})`;
  const data = items.map((item, index) => ({ name: item.label, value: plotValue(item.value, unit), itemStyle: { color: PALETTE[index % PALETTE.length] } }));
  return <ReactECharts notMerge style={{ height: 260 }} option={{
    tooltip: { formatter: (params: { dataIndex: number }) => describe(params.dataIndex) },
    series: type === "treemap"
      ? [{ type: "treemap", data, roam: false, breadcrumb: { show: false }, upperLabel: { show: false }, label: { color: colors.card, overflow: "truncate" }, itemStyle: { borderColor: colors.card, borderWidth: 2, gapWidth: 2 } }]
      : [{ type: "pie", data, radius: type === "donut" ? ["55%", "80%"] : "75%", label: { show: false }, labelLine: { show: false }, itemStyle: { borderColor: colors.card, borderWidth: 2 } }],
  }} />;
}

/** Renders a model-written ```moneo-chart block: a bar, line, area, pie, donut, treemap or bubble chart plus its exact values. */
export function ChatChart({ source }: { source: string }) {
  let chart: ChartSpec | undefined;
  try { chart = chartSchema.parse(JSON.parse(source)); } catch { chart = undefined; }
  if (!chart) return <p className="my-2 text-sm text-muted-foreground">The chart could not be drawn from this data.</p>;
  return <figure className="ai-chart my-4 min-w-0 max-w-full rounded-xl border border-border bg-card p-4" aria-label={chart.title}>
    <figcaption className="mb-3 text-sm font-medium">{chart.title}</figcaption>
    {"labels" in chart ? <CartesianChart chart={chart} /> : <CircularChart chart={chart} />}
    <ChartTable chart={chart} />
  </figure>;
}
