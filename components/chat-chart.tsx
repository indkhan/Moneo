"use client";

import Link from "next/link";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import { averageMinor, parseChart, waterfallBars, type BandSpec, type CalendarSpec, type CartesianSpec, type ChartSpec, type ChartUnit, type CircularSpec, type ComboSpec, type SankeySpec, type ScatterSpec, type WaterfallSpec } from "@/lib/ai/chart-spec";
import { ReactECharts, useThemeColors } from "./chart";

// Categorical slots in a fixed order, each stepped for its own surface; the light pair matches --color-chart-input/output.
const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};
// Magnitude in one hue: faint near nothing, strong for the most.
const SEQUENTIAL = { light: ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"], dark: ["#173a63", "#1c5cab", "#2a78d6", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"] };
const FONT = "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif";
// Labels inside a fill are white, except on yellow.
const inkOn = (index: number) => index === 3 ? "#0b0b0b" : "#ffffff";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

function formatAmount(value: string | bigint, unit: ChartUnit) {
  return unit.kind === "money" ? formatMoney(value, unit.currency) : BigInt(value).toLocaleString("en-US");
}
// Plotting uses major units for scale only; every number a reader sees comes from formatAmount.
function plotValue(value: string | bigint, unit: ChartUnit) {
  return unit.kind === "money" ? Number(value) / 10 ** minorDigits(unit.currency) : Number(value);
}
function compact(unit: ChartUnit) {
  const format = unit.kind === "money" ? new Intl.NumberFormat("en-US", { style: "currency", currency: unit.currency, notation: "compact", maximumFractionDigits: 1 })
    : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
  return (value: number) => format.format(value);
}
const abs = (value: bigint) => value < 0n ? -value : value;

// ISO days and months read as dates: short on the axis, in full in tooltips and the table.
type LabelKind = "day" | "month" | null;
function labelKind(labels: string[]): LabelKind {
  if (labels.every(label => /^\d{4}-\d{2}-\d{2}$/.test(label))) return "day";
  if (labels.every(label => /^\d{4}-\d{2}$/.test(label))) return "month";
  return null;
}
const dates = {
  day: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
  dayLong: new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
  month: new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }),
  monthYear: new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
};
function labelText(label: string, kind: LabelKind, long = false, spansYears = false) {
  if (kind === "month") return (long || spansYears ? dates.monthYear : dates.month).format(new Date(`${label}-01T00:00:00Z`));
  if (kind === "day") {
    const date = new Date(`${label}T00:00:00Z`);
    return long ? dates.dayLong.format(date) : dates.day.format(date);
  }
  return label;
}

function hexAlpha(hex: string, alpha: number) {
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
/** Whether the card behind the chart is dark, read from its resolved colour so the system theme counts too. */
function isDark(color: string) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  let channels = hex ? [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16)) : (color.match(/\d+(?:\.\d+)?/g) ?? []).slice(0, 3).map(Number);
  if (channels.length < 3) return false;
  if (channels.every(channel => channel <= 1)) channels = channels.map(channel => channel * 255);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2] < 128;
}

function useChartTheme() {
  const colors = useThemeColors();
  return useMemo(() => {
    const dark = isDark(colors.card);
    const series = dark ? SERIES.dark : SERIES.light;
    return { ...colors, dark, series, sequential: dark ? SEQUENTIAL.dark : SEQUENTIAL.light, up: series[0], down: series[7], empty: dark ? "#26272b" : "#efeee9",
      /** A ninth item and beyond are grey: hues never cycle, and the table keeps each one's identity. */
      color: (index: number) => index < series.length ? series[index] : colors.out };
  }, [colors]);
}
type Theme = ReturnType<typeof useChartTheme>;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
function base(theme: Theme) {
  return {
    animation: !reducedMotion(), animationDuration: 650, animationEasing: "cubicOut", animationDurationUpdate: 300,
    textStyle: { fontFamily: FONT, color: theme.muted },
    tooltip: { confine: true, backgroundColor: theme.card, borderColor: theme.border, borderWidth: 1, padding: [8, 10],
      textStyle: { color: theme.foreground, fontSize: 12, fontFamily: FONT }, extraCssText: "border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.16);" },
  };
}
// Tooltip rows; every name is escaped, colours are the app's own.
const swatch = (color: string) => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${color}"></span>`;
const tipRow = (color: string | null, name: string, value: string) =>
  `<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.7"><span>${color ? swatch(color) : ""}${escapeHtml(name)}</span><span style="font-variant-numeric:tabular-nums;font-weight:600">${escapeHtml(value)}</span></div>`;
const tipHead = (theme: Theme, text: string) => `<div style="color:${theme.muted};margin-bottom:2px">${escapeHtml(text)}</div>`;
const legend = (theme: Theme, names: string[]) => ({ top: 0, left: 0, data: names, icon: "roundRect", itemWidth: 10, itemHeight: 10, itemGap: 14, textStyle: { color: theme.muted, fontSize: 12 } });

function Plot({ height, label, option }: { height: number; label: string; option: object }) {
  // The box keeps its height while echarts loads, so the answer doesn't jump.
  return <div role="img" aria-label={label} style={{ height }}><ReactECharts notMerge style={{ height }} option={option} /></div>;
}

type Plotted = { name: string; values: string[]; as: "bar" | "line" | "area"; right: boolean };

function SeriesChart({ chart, width }: { chart: CartesianSpec | ComboSpec | BandSpec; width: number }) {
  const theme = useChartTheme();
  const option = useMemo(() => {
    const { unit, labels } = chart;
    const horizontal = chart.type === "bar" && chart.horizontal === true;
    const stacked = (chart.type === "bar" || chart.type === "line" || chart.type === "area") && chart.stacked === true;
    const series: Plotted[] = chart.type === "combo" ? chart.series.map(item => ({ name: item.name, values: item.values, as: item.as, right: item.axis === "right" }))
      : chart.series.map(item => ({ name: item.name, values: item.values, as: chart.type === "band" ? "line" : chart.type, right: false }));
    const band = chart.type === "band" ? chart.band : null;
    const kind = labelKind(labels);
    const spansYears = kind !== null && new Set(labels.map(label => label.slice(0, 4))).size > 1;
    const hasBars = series.some(item => item.as === "bar"), hasRight = series.some(item => item.right);
    const narrow = width < 480, count = labels.length;
    const names = [...(band ? [band.name] : []), ...series.map(item => item.name)];
    const showLegend = names.length > 1;
    const plot = (values: string[]) => values.map(value => plotValue(value, unit));
    // Long daily series label month starts only, so a year reads as twelve ticks.
    const interval = kind === "day" && count > 120 ? (_: number, value: string) => value.endsWith("-01")
      : kind === "day" && count > 45 ? (_: number, value: string) => value.endsWith("-01") || value.endsWith("-15") : "auto";
    const categoryAxis = { type: "category", data: labels, boundaryGap: hasBars, inverse: horizontal, axisLine: { lineStyle: { color: theme.border } }, axisTick: { show: false },
      axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, interval, formatter: (label: string) => kind === "day" && count > 120
        ? label.endsWith("-01-01") ? label.slice(0, 4) : labelText(label.slice(0, 7), "month") : labelText(label, kind, false, spansYears) } };
    const zoom = !hasBars && !stacked && series.every(item => item.as === "line");
    const valueAxis = (right: boolean) => ({ type: "value", position: horizontal ? undefined : right ? "right" : "left", splitNumber: narrow ? 4 : 5, scale: zoom,
      axisLabel: { color: theme.muted, fontSize: 11, formatter: compact(unit) }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { show: !right, lineStyle: { color: theme.border } } });
    // Reference lines sit on the series they average (so on its axis); fixed amounts on the first series.
    const lines = series.map(() => [] as object[]);
    for (const reference of chart.references ?? []) {
      const owner = "average" in reference ? series.findIndex(item => item.name === reference.average) : series.findIndex(item => !item.right);
      const value = "average" in reference ? averageMinor(series[owner].values) : BigInt(reference.value);
      const text = `${reference.label} ${formatAmount(value, unit)}`;
      lines[owner].push({ [horizontal ? "xAxis" : "yAxis"]: plotValue(value, unit), label: { formatter: () => text, position: horizontal ? "end" : "insideEndTop" } });
    }
    for (const marker of chart.markers ?? []) lines[0].push({ [horizontal ? "yAxis" : "xAxis"]: marker.at, label: { formatter: () => marker.label, position: horizontal ? "insideEndTop" : "end" } });
    const markLine = (data: object[]) => data.length ? { markLine: { symbol: ["none", "none"], silent: true, data, lineStyle: { color: theme.muted, type: [4, 4], width: 1 }, label: { color: theme.muted, fontSize: 11, backgroundColor: theme.card, padding: [1, 4], borderRadius: 4 }, emphasis: { disabled: true } } } : {};
    const plotted = series.map((item, index) => {
      const color = theme.color(index);
      const common = { name: item.name, yAxisIndex: item.right ? 1 : 0, data: plot(item.values), emphasis: { focus: "series" }, ...markLine(lines[index]) };
      if (item.as === "bar") return { ...common, type: "bar", stack: stacked ? "total" : undefined, barMaxWidth: 28, barCategoryGap: count > 60 ? "15%" : "35%",
        itemStyle: { color, borderRadius: stacked ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0], borderColor: theme.card, borderWidth: stacked ? 1 : 0 } };
      return { ...common, type: "line", stack: stacked ? "total" : undefined, showSymbol: count <= 16, symbol: "circle", symbolSize: 7, smooth: 0.2, smoothMonotone: "x",
        itemStyle: { color, borderColor: theme.card, borderWidth: 1.5 }, lineStyle: { width: 2, color },
        areaStyle: item.as === "area" ? { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: hexAlpha(color, stacked ? 0.55 : 0.28) }, { offset: 1, color: hexAlpha(color, stacked ? 0.35 : 0.02) }] } } : undefined };
    });
    const bandSeries = band ? [
      { name: "band-low", type: "line", stack: "band", stackStrategy: "all", data: plot(band.low), symbol: "none", lineStyle: { opacity: 0 }, silent: true, tooltip: { show: false } },
      { name: band.name, type: "line", stack: "band", stackStrategy: "all", data: band.high.map((high, index) => plotValue(BigInt(high) - BigInt(band.low[index]), unit)), symbol: "none", silent: true,
        lineStyle: { opacity: 0 }, itemStyle: { color: hexAlpha(theme.color(0), 0.35) }, areaStyle: { color: hexAlpha(theme.color(0), theme.dark ? 0.22 : 0.16) } },
    ] : [];
    const tooltip = (items: { dataIndex: number }[]) => {
      const index = items[0]?.dataIndex;
      if (index === undefined) return "";
      const rows = series.map((item, position) => tipRow(theme.color(position), item.name, formatAmount(item.values[index], unit)));
      if (stacked && series.length > 1) rows.push(tipRow(null, "Total", formatAmount(series.reduce((sum, item) => sum + BigInt(item.values[index]), 0n), unit)));
      if (band) rows.push(tipRow(hexAlpha(theme.color(0), 0.45), band.name, `${formatAmount(band.low[index], unit)} – ${formatAmount(band.high[index], unit)}`));
      return tipHead(theme, labelText(labels[index], kind, true)) + rows.join("");
    };
    const top = (showLegend ? 34 : 12) + (chart.markers?.length && !horizontal ? 14 : 0);
    return {
      ...base(theme),
      grid: { left: 4, right: hasRight ? 4 : 16, top, bottom: 4, containLabel: true },
      legend: showLegend ? legend(theme, names) : undefined,
      tooltip: { ...base(theme).tooltip, trigger: "axis", formatter: tooltip,
        axisPointer: { type: hasBars ? "shadow" : "line", lineStyle: { color: theme.muted, width: 1, type: [3, 3] }, shadowStyle: { color: hexAlpha(theme.dark ? "#ffffff" : "#000000", 0.05) } } },
      xAxis: horizontal ? valueAxis(false) : categoryAxis,
      yAxis: horizontal ? categoryAxis : hasRight ? [valueAxis(false), valueAxis(true)] : valueAxis(false),
      series: [...bandSeries, ...plotted],
    };
  }, [chart, theme, width]);
  const horizontal = chart.type === "bar" && chart.horizontal === true;
  const height = horizontal ? Math.max(200, chart.labels.length * 28 + (chart.series.length > 1 ? 50 : 20)) : width < 480 ? 240 : 290;
  return <Plot height={height} label={chart.title} option={option} />;
}

function WaterfallChart({ chart, width }: { chart: WaterfallSpec; width: number }) {
  const theme = useChartTheme();
  const bars = useMemo(() => waterfallBars(chart), [chart]);
  const option = useMemo(() => {
    const narrow = width < 480;
    const colorOf = (bar: typeof bars[number]) => bar.kind === "total" ? theme.muted : bar.value < 0n ? theme.down : theme.up;
    const short = compact(chart.unit);
    return {
      ...base(theme),
      grid: { left: 4, right: 12, top: 22, bottom: 4, containLabel: true },
      tooltip: { ...base(theme).tooltip, trigger: "item", formatter: ({ dataIndex }: { dataIndex: number }) => {
        const bar = bars[dataIndex];
        if (!bar) return "";
        if (bar.kind === "total") return tipHead(theme, bar.label) + tipRow(colorOf(bar), "Total", formatAmount(bar.value, chart.unit));
        return tipHead(theme, bar.label) + tipRow(colorOf(bar), "Change", `${bar.value > 0n ? "+" : ""}${formatAmount(bar.value, chart.unit)}`) + tipRow(null, "Running total", formatAmount(bar.to, chart.unit));
      } },
      xAxis: { type: "category", data: bars.map(bar => bar.label), axisLine: { lineStyle: { color: theme.border } }, axisTick: { show: false },
        axisLabel: { color: theme.muted, fontSize: 11, interval: 0, rotate: narrow && bars.length > 4 ? 40 : 0, width: narrow ? 72 : 96, overflow: "truncate" } },
      yAxis: { type: "value", splitNumber: narrow ? 4 : 5, axisLabel: { color: theme.muted, fontSize: 11, formatter: short }, splitLine: { lineStyle: { color: theme.border } } },
      series: [
        // An invisible base lifts each step to where the running total stood.
        { type: "bar", stack: "bridge", stackStrategy: "all", silent: true, itemStyle: { color: "transparent" }, emphasis: { disabled: true }, tooltip: { show: false },
          data: bars.map(bar => plotValue(bar.from < bar.to ? bar.from : bar.to, chart.unit)) },
        { type: "bar", stack: "bridge", stackStrategy: "all", barMaxWidth: 44, barCategoryGap: "30%",
          data: bars.map(bar => ({ value: plotValue(abs(bar.to - bar.from), chart.unit), itemStyle: { color: colorOf(bar), borderRadius: 3 } })),
          label: { show: bars.length <= (narrow ? 6 : 14), position: "top", color: theme.muted, fontSize: 11,
            formatter: ({ dataIndex }: { dataIndex: number }) => { const bar = bars[dataIndex]; return bar.kind === "step" && bar.value > 0n ? `+${short(plotValue(bar.value, chart.unit))}` : short(plotValue(bar.value, chart.unit)); } } },
      ],
    };
  }, [bars, chart.unit, theme, width]);
  return <Plot height={width < 480 ? 270 : 300} label={chart.title} option={option} />;
}

function SankeyChart({ chart }: { chart: SankeySpec }) {
  const theme = useChartTheme();
  const nodes = useMemo(() => [...new Set(chart.links.flatMap(link => [link.from, link.to]))], [chart]);
  const option = useMemo(() => {
    const inflow = new Map<string, bigint>(), outflow = new Map<string, bigint>();
    for (const link of chart.links) {
      outflow.set(link.from, (outflow.get(link.from) ?? 0n) + BigInt(link.value));
      inflow.set(link.to, (inflow.get(link.to) ?? 0n) + BigInt(link.value));
    }
    const total = (name: string) => (inflow.get(name) ?? 0n) > (outflow.get(name) ?? 0n) ? inflow.get(name)! : outflow.get(name) ?? 0n;
    const short = compact(chart.unit);
    // Rich-text labels: braces and bars in a name would read as markup.
    const plain = (name: string) => name.replace(/[{}|]/g, "");
    return {
      ...base(theme),
      tooltip: { ...base(theme).tooltip, trigger: "item", formatter: (params: { dataType: string; data: { source?: string; target?: string; name?: string }; dataIndex: number }) => {
        if (params.dataType === "edge") {
          const link = chart.links[params.dataIndex];
          return tipHead(theme, `${link.from} → ${link.to}`) + tipRow(null, "Amount", formatAmount(link.value, chart.unit));
        }
        const name = nodes[params.dataIndex];
        return tipRow(theme.color(params.dataIndex), name, formatAmount(total(name), chart.unit));
      } },
      series: [{
        type: "sankey", left: 4, right: 4, top: 8, bottom: 8, nodeWidth: 12, nodeGap: 16, nodeAlign: "justify", draggable: false, layoutIterations: 32,
        data: nodes.map((name, index) => ({ name, itemStyle: { color: theme.color(index) },
          label: { position: outflow.has(name) ? "right" : "left", formatter: () => `{n|${plain(name)}}  {v|${short(plotValue(total(name), chart.unit))}}` } })),
        links: chart.links.map(link => ({ source: link.from, target: link.to, value: plotValue(link.value, chart.unit) })),
        lineStyle: { color: "gradient", opacity: theme.dark ? 0.38 : 0.3, curveness: 0.5 },
        itemStyle: { borderWidth: 0, borderRadius: 2 },
        emphasis: { focus: "adjacency", lineStyle: { opacity: 0.55 } },
        label: { color: theme.foreground, fontSize: 12, rich: { n: { color: theme.foreground, fontSize: 12 }, v: { color: theme.muted, fontSize: 11 } } },
      }],
    };
  }, [chart, nodes, theme]);
  const sinks = nodes.filter(name => !chart.links.some(link => link.from === name)).length;
  const sources = nodes.filter(name => !chart.links.some(link => link.to === name)).length;
  return <Plot height={Math.max(240, Math.max(sinks, sources) * 34 + 16)} label={chart.title} option={option} />;
}

function ScatterChart({ chart, width }: { chart: ScatterSpec; width: number }) {
  const theme = useChartTheme();
  const option = useMemo(() => {
    const narrow = width < 480;
    const axis = (title: string, unit: ChartUnit, x: boolean) => ({ type: "value", scale: true, name: title, nameLocation: x ? "middle" : "end", nameGap: x ? 28 : 12,
      nameTextStyle: { color: theme.muted, fontSize: 11, align: x ? "center" : "left" }, splitNumber: narrow ? 4 : 5,
      axisLabel: { color: theme.muted, fontSize: 11, formatter: compact(unit) }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: theme.border } } });
    return {
      ...base(theme),
      grid: { left: 4, right: 16, top: chart.series.length > 1 ? 52 : 30, bottom: 30, containLabel: true },
      legend: chart.series.length > 1 ? legend(theme, chart.series.map(item => item.name)) : undefined,
      tooltip: { ...base(theme).tooltip, trigger: "item", formatter: ({ seriesIndex, dataIndex }: { seriesIndex: number; dataIndex: number }) => {
        const series = chart.series[seriesIndex], point = series?.points[dataIndex];
        if (!point) return "";
        return tipHead(theme, point.label ?? series.name) + tipRow(theme.color(seriesIndex), chart.xTitle, formatAmount(point.x, chart.xUnit)) + tipRow(null, chart.yTitle, formatAmount(point.y, chart.unit));
      } },
      xAxis: axis(chart.xTitle, chart.xUnit, true),
      yAxis: axis(chart.yTitle, chart.unit, false),
      series: chart.series.map((series, index) => ({ type: "scatter", name: series.name, symbolSize: 9, emphasis: { scale: 1.5 },
        itemStyle: { color: theme.color(index), opacity: 0.85, borderColor: theme.card, borderWidth: 1 },
        data: series.points.map(point => [plotValue(point.x, chart.xUnit), plotValue(point.y, chart.unit)]) })),
    };
  }, [chart, theme, width]);
  return <Plot height={width < 480 ? 260 : 300} label={chart.title} option={option} />;
}

const monthKey = (date: string) => date.slice(0, 7);
function CalendarChart({ chart, width }: { chart: CalendarSpec; width: number }) {
  const theme = useChartTheme();
  const layout = useMemo(() => {
    const days = [...chart.days].sort((a, b) => a.date.localeCompare(b.date));
    const months = [...new Set(days.map(day => monthKey(day.date)))];
    // As many months per row as fit with cells of at least 13px; a year splits into rows on a phone.
    const available = width - 44;
    const fit = Math.max(1, Math.min(months.length, Math.floor(available / 13 / 4.6)));
    const count = Math.ceil(months.length / fit), rows: string[][] = [];
    // Even rows: 13 months in rows of up to four read 4-3-3-3, not 4-4-4-1.
    for (let index = 0, row = 0; row < count; row++) {
      const size = Math.floor(months.length / count) + (row < months.length % count ? 1 : 0);
      rows.push(months.slice(index, index + size));
      index += size;
    }
    const weeks = (row: string[]) => Math.ceil((Date.parse(`${days.filter(day => row.includes(monthKey(day.date))).at(-1)!.date}T00:00:00Z`) - Date.parse(`${row[0]}-01T00:00:00Z`)) / 86_400_000 / 7) + 2;
    const cell = Math.max(10, Math.min(22, Math.floor(available / Math.max(...rows.map(weeks)))));
    return { days, rows, cell, rowHeight: cell * 7 + 30 };
  }, [chart, width]);
  const option = useMemo(() => {
    const { days, rows, cell, rowHeight } = layout;
    const exact = new Map(days.map(day => [day.date, day.value]));
    const values = days.map(day => plotValue(day.value, chart.unit));
    const positive = values.filter(value => value > 0);
    const min = positive.length ? Math.min(...positive) : 1, max = positive.length ? Math.max(...positive) : 1;
    const ranges = rows.map(row => {
      const inRow = days.filter(day => row.includes(monthKey(day.date)));
      return [inRow[0].date, inRow.at(-1)!.date];
    });
    return {
      ...base(theme),
      tooltip: { ...base(theme).tooltip, trigger: "item", formatter: ({ data }: { data: [string, number] }) =>
        tipHead(theme, labelText(data[0], "day", true)) + tipRow(null, chart.title, formatAmount(exact.get(data[0]) ?? "0", chart.unit)) },
      // Days with nothing fall outside the scale and keep the empty cell colour.
      visualMap: { type: "continuous", min, max, calculable: false, orient: "horizontal", left: 30, bottom: 0, itemWidth: 10, itemHeight: 110, text: ["More", "Less"],
        textStyle: { color: theme.muted, fontSize: 11 }, inRange: { color: theme.sequential }, outOfRange: { color: theme.empty }, seriesIndex: rows.map((_, index) => index) },
      calendar: ranges.map((range, index) => ({ range, top: 22 + index * rowHeight, left: 30, cellSize: [cell, cell], orient: "horizontal",
        splitLine: { show: false }, itemStyle: { color: theme.empty, borderColor: theme.card, borderWidth: 2 },
        dayLabel: { firstDay: 1, nameMap: ["", "Mon", "", "Wed", "", "Fri", ""], color: theme.muted, fontSize: 10 },
        monthLabel: { color: theme.muted, fontSize: 11 }, yearLabel: { show: false } })),
      series: ranges.map((range, index) => ({ type: "heatmap", coordinateSystem: "calendar", calendarIndex: index,
        data: days.filter(day => day.date >= range[0] && day.date <= range[1]).map(day => [day.date, plotValue(day.value, chart.unit)]) })),
    };
  }, [chart, layout, theme]);
  return <Plot height={22 + layout.rows.length * layout.rowHeight + 34} label={chart.title} option={option} />;
}

/** Circles that never overlap; each one goes to the nearest free spot on a spiral out from the centre. */
function packCircles(radii: number[]) {
  const placed: { x: number; y: number; r: number }[] = [];
  for (const r of radii) {
    const clear = (x: number, y: number) => placed.every(other => Math.hypot(x - other.x, y - other.y) >= r + other.r + 3);
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

const shareOf = (value: string, total: bigint) => total ? percent.format(Number(value) / Number(total)) : "0%";

function CircularChart({ chart, width }: { chart: CircularSpec; width: number }) {
  const theme = useChartTheme();
  const { type, unit, items } = chart;
  const total = useMemo(() => items.reduce((sum, item) => sum + BigInt(item.value), 0n), [items]);
  const share = (value: string) => shareOf(value, total);
  const option = useMemo(() => {
    const short = compact(unit);
    const data = items.map((item, index) => ({ name: item.label, value: plotValue(item.value, unit), itemStyle: { color: theme.color(index) },
      label: { color: index < 8 ? inkOn(index) : theme.foreground } }));
    const describe = (index: number) => tipRow(theme.color(index), items[index].label, `${formatAmount(items[index].value, unit)} · ${shareOf(items[index].value, total)}`);
    return {
      ...base(theme),
      tooltip: { ...base(theme).tooltip, trigger: "item", formatter: ({ dataIndex }: { dataIndex: number }) => describe(dataIndex) },
      series: type === "treemap"
        ? [{ type: "treemap", data, roam: false, nodeClick: false, breadcrumb: { show: false }, upperLabel: { show: false }, left: 0, right: 0, top: 0, bottom: 0,
          label: { show: true, fontSize: 12, overflow: "truncate", formatter: ({ name, value }: { name: string; value: number }) => `${name}\n${short(value)}` },
          itemStyle: { borderColor: theme.card, borderWidth: 2, gapWidth: 2, borderRadius: 4 } }]
        : [{ type: "pie", data, radius: type === "donut" ? ["60%", "86%"] : ["0%", "86%"], padAngle: type === "donut" ? 1.5 : 0, label: { show: false }, labelLine: { show: false },
          itemStyle: { borderColor: theme.card, borderWidth: type === "donut" ? 0 : 2, borderRadius: type === "donut" ? 4 : 2 }, emphasis: { scale: true, scaleSize: 5 } }],
    };
  }, [items, total, type, unit, theme]);
  const legendList = <ul className={`grid min-w-0 gap-x-6 gap-y-1.5 text-sm ${type === "pie" || type === "donut" ? "max-w-xs" : "sm:grid-cols-2"}`}>
    {items.map((item, index) => <li key={index} className="flex items-baseline gap-2">
      <span className="inline-block size-2.5 shrink-0 translate-y-px rounded-[3px]" style={{ background: theme.color(index) }} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      <span className="tabular-nums text-muted-foreground">{share(item.value)}</span>
    </li>)}
  </ul>;
  if (type === "treemap") return <><Plot height={width < 480 ? 260 : 300} label={chart.title} option={option} /><div className="mt-3">{legendList}</div></>;
  if (type === "bubble") {
    // Circle area is proportional to amount, so the biggest item sets the scale.
    const values = items.map(item => Number(item.value));
    const largest = Math.max(...values) || 1;
    const order = items.map((_, index) => index).sort((a, b) => values[b] - values[a]);
    const circles = packCircles(order.map(index => Math.max(3, 100 * Math.sqrt(values[index] / largest))));
    const minX = Math.min(...circles.map(c => c.x - c.r)) - 4, minY = Math.min(...circles.map(c => c.y - c.r)) - 4;
    const maxX = Math.max(...circles.map(c => c.x + c.r)) + 4, maxY = Math.max(...circles.map(c => c.y + c.r)) + 4;
    const short = compact(unit);
    return <><svg role="img" aria-label={chart.title} viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} className="mx-auto h-64 w-full" style={{ fontFamily: FONT }}>
      {order.map((index, slot) => {
        const { x, y, r } = circles[slot];
        const size = Math.min(16, r * 0.3);
        return <g key={index}>
          <circle cx={x} cy={y} r={r} fill={theme.color(index)} stroke={theme.card} strokeWidth={1.5}><title>{`${items[index].label}: ${formatAmount(items[index].value, unit)}`}</title></circle>
          {r >= 22 && <text x={x} y={y} textAnchor="middle" fill={index < 8 ? inkOn(index) : theme.foreground} fontSize={size} pointerEvents="none">
            <tspan x={x} dy={-size * 0.15}>{items[index].label.length > 14 ? `${items[index].label.slice(0, 13)}…` : items[index].label}</tspan>
            <tspan x={x} dy={size * 1.2} fontWeight={600}>{short(plotValue(items[index].value, unit))}</tspan>
          </text>}
        </g>;
      })}
    </svg><div className="mt-3">{legendList}</div></>;
  }
  const size = width < 480 ? 200 : 220;
  return <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-8">
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <Plot height={size} label={chart.title} option={option} />
      {type === "donut" && <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-xs text-muted-foreground">Total</span>
        <span className="text-sm font-semibold tabular-nums">{formatAmount(total, unit)}</span>
      </div>}
    </div>
    <div className="w-full min-w-0 sm:w-auto sm:flex-1">{legendList}</div>
  </div>;
}

type Table = { head: ReactNode[]; rows: { label: ReactNode; cells: string[] }[]; foot?: string[] };
const dot = (color: string) => <span className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ background: color }} aria-hidden="true" />;

function tableFor(chart: ChartSpec, theme: Theme): Table {
  const unit = chart.unit;
  switch (chart.type) {
    case "bar": case "line": case "area": case "combo": case "band": {
      const kind = labelKind(chart.labels);
      const band = chart.type === "band" ? chart.band : null;
      return {
        head: [...chart.series.map((series, index) => <>{dot(theme.color(index))}{series.name}{"axis" in series && series.axis === "right" ? " (right)" : ""}</>), ...(band ? [`${band.name} low`, `${band.name} high`] : [])],
        rows: chart.labels.map((label, row) => ({ label: labelText(label, kind, true), cells: [...chart.series.map(series => formatAmount(series.values[row], unit)), ...(band ? [formatAmount(band.low[row], unit), formatAmount(band.high[row], unit)] : [])] })),
      };
    }
    case "waterfall": return { head: ["Change", "Running total"],
      rows: waterfallBars(chart).map(bar => ({ label: bar.label, cells: bar.kind === "total" ? ["", formatAmount(bar.value, unit)] : [`${bar.value > 0n ? "+" : ""}${formatAmount(bar.value, unit)}`, formatAmount(bar.to, unit)] })) };
    case "sankey": return { head: ["To", "Amount"], rows: chart.links.map(link => ({ label: link.from, cells: [link.to, formatAmount(link.value, unit)] })) };
    case "scatter": return { head: [chart.xTitle, chart.yTitle],
      rows: chart.series.flatMap((series, index) => series.points.map(point => ({ label: <>{dot(theme.color(index))}{point.label ?? series.name}</>, cells: [formatAmount(point.x, chart.xUnit), formatAmount(point.y, unit)] }))) };
    case "calendar": {
      const days = [...chart.days].sort((a, b) => a.date.localeCompare(b.date));
      return { head: ["Amount"], rows: days.map(day => ({ label: labelText(day.date, "day", true), cells: [formatAmount(day.value, unit)] })),
        foot: ["Total", formatAmount(days.reduce((sum, day) => sum + BigInt(day.value), 0n), unit)] };
    }
    default: {
      const total = chart.items.reduce((sum, item) => sum + BigInt(item.value), 0n);
      return { head: ["Amount", "Share"],
        rows: chart.items.map((item, index) => ({ label: <>{dot(theme.color(index))}{item.href ? <Link href={item.href} className="hover:underline" title="Open matching transactions">{item.label}</Link> : item.label}</>,
          cells: [formatAmount(item.value, unit), shareOf(item.value, total)] })),
        foot: ["Total", formatAmount(total, unit), "100%"] };
    }
  }
}

function ChartTable({ chart }: { chart: ChartSpec }) {
  const theme = useChartTheme();
  const table = tableFor(chart, theme);
  return <div className="mt-2 max-h-80 overflow-auto"><table className="w-full text-sm tabular-nums">
    <thead className="text-xs text-muted-foreground"><tr><th className="py-1 text-left font-normal" />{table.head.map((cell, index) => <th key={index} className="py-1 pl-3 text-right font-normal">{cell}</th>)}</tr></thead>
    <tbody>{table.rows.map((row, index) => <tr key={index} className="border-t border-border">
      <th scope="row" className="py-1.5 pr-3 text-left font-normal [overflow-wrap:anywhere]">{row.label}</th>
      {row.cells.map((cell, column) => <td key={column} className="py-1.5 pl-3 text-right">{cell}</td>)}
    </tr>)}</tbody>
    {table.foot && <tfoot><tr className="border-t border-border font-medium"><th scope="row" className="py-1.5 pr-3 text-left font-medium">{table.foot[0]}</th>{table.foot.slice(1).map((cell, index) => <td key={index} className="py-1.5 pl-3 text-right">{cell}</td>)}</tr></tfoot>}
  </table></div>;
}

function Chart({ chart }: { chart: ChartSpec }) {
  const [ref, width] = useWidth();
  return <div ref={ref} className="min-w-0">{
    chart.type === "waterfall" ? <WaterfallChart chart={chart} width={width} />
      : chart.type === "sankey" ? <SankeyChart chart={chart} />
        : chart.type === "scatter" ? <ScatterChart chart={chart} width={width} />
          : chart.type === "calendar" ? <CalendarChart chart={chart} width={width} />
            : "items" in chart ? <CircularChart chart={chart} width={width} />
              : <SeriesChart chart={chart} width={width} />
  }</div>;
}

type Parsed = { state: "chart"; chart: ChartSpec } | { state: "loading" } | { state: "error"; reason?: string };
function parse(source: string): Parsed {
  let value: unknown;
  try { value = JSON.parse(source); } catch { return { state: "error" }; }
  if (typeof value === "object" && value !== null) {
    // The server swaps a dataset reference for its exact values when the answer is done; until then it's still loading.
    if ("datasetId" in value) return { state: "loading" };
    if ("unavailable" in value && typeof value.unavailable === "string") return { state: "error", reason: value.unavailable };
  }
  const parsed = parseChart(value);
  return parsed.ok ? { state: "chart", chart: parsed.chart } : { state: "error" };
}

/** Renders a ```moneo-chart block: the chart, a legend where it needs one, and every exact value in a table. */
export const ChatChart = memo(function ChatChart({ source }: { source: string }) {
  const parsed = useMemo(() => parse(source), [source]);
  if (parsed.state === "loading") return <div className="my-4 flex h-40 items-center justify-center rounded-xl border border-border bg-card text-sm text-muted-foreground" role="status">Loading chart…</div>;
  if (parsed.state === "error") return <p className="my-2 text-sm text-muted-foreground">The chart could not be drawn from this data{parsed.reason ? `: ${parsed.reason}` : "."}</p>;
  const { chart } = parsed;
  return <figure className="ai-chart my-4 min-w-0 max-w-full rounded-xl border border-border bg-card p-4" aria-label={chart.title}>
    <figcaption className="mb-3 text-sm font-medium">{chart.title}</figcaption>
    <Chart chart={chart} />
    <details className="mt-3 border-t border-border pt-2">
      <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">Show values</summary>
      <ChartTable chart={chart} />
    </details>
  </figure>;
});
