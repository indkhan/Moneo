"use client";

import { useMemo, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { chartValue, type ChartSpec } from "@/lib/ai/chart-spec";

// Loaded on the client only, so echarts never ships in the server render or blocks first paint.
const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

// Chart colors follow the app's CSS tokens, including the dark theme.
function useThemeColors() {
  const theme = useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.theme ?? "light", () => "light");
  return useMemo(() => {
    const fallback = theme === "dark" ? { brand: "#83b3ff", muted: "#b1c0d5", border: "#3a4a62" } : { brand: "#0051d5", muted: "#57677c", border: "#dce5f2" };
    if (typeof document === "undefined") return fallback;
    const style = getComputedStyle(document.documentElement);
    const read = (name: string, value: string) => style.getPropertyValue(name).trim() || value;
    return { brand: read("--color-brand", fallback.brand), muted: read("--color-muted-foreground", fallback.muted), border: read("--color-border", fallback.border) };
  }, [theme]);
}

export function SpendingChart({ values, labels, type = "bar", height = 280, ariaLabel, formatValue, onSelect }: {
  values: number[];
  labels?: string[];
  type?: "bar" | "line";
  height?: number;
  ariaLabel?: string;
  formatValue?: (value: number) => string;
  onSelect?: (index: number) => void;
}) {
  const colors = useThemeColors();
  const axis = { axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.muted }, splitLine: { lineStyle: { color: colors.border } } };
  return (
    <div role={ariaLabel ? "img" : undefined} aria-label={ariaLabel}>
      <ReactECharts
        option={{
          color: [colors.brand],
          grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
          tooltip: { trigger: "axis", ...(formatValue ? { valueFormatter: formatValue } : {}) },
          xAxis: { type: "category", data: labels ?? values.map((_, i) => `W${i + 1}`), ...axis },
          yAxis: { type: "value", ...axis, ...(formatValue ? { axisLabel: { color: colors.muted, formatter: formatValue } } : {}) },
          series: [{ type, data: values, ...(type === "line" ? { smooth: true, showSymbol: false, areaStyle: { opacity: 0.12 } } : { barMaxWidth: 28, itemStyle: { borderRadius: [4, 4, 0, 0] } }) }],
        }}
        style={{ height, cursor: onSelect ? "pointer" : undefined }}
        onEvents={onSelect ? { click: (event: { dataIndex: number }) => onSelect(event.dataIndex) } : undefined}
      />
    </div>
  );
}

type ForecastChartDay = { date: string; expected: number; conservative: number; optimistic: number };
type ForecastChartObligation = { date: string; name: string; amount: string };

function token(name: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// Approximate chart coordinates (major units as numbers); exact amounts are rendered by the caller.
export function ForecastChart({ days, obligations, currency, label, compare }: {
  days: ForecastChartDay[]; obligations: ForecastChartObligation[]; currency: string; label: string;
  /** Optional second expected line, e.g. the real plan while a what-if scenario is shown. */
  compare?: { name: string; values: number[] };
}) {
  const brand = token("--color-brand", "#0051d5"), muted = token("--color-muted-foreground", "#57677c"), border = token("--color-border", "#dce5f2");
  const expectedOn = new Map(days.map(day => [day.date, day.expected]));
  return <div role="img" aria-label={label}>
    <ReactECharts style={{ height: 260 }} option={{
      grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
      tooltip: { trigger: "axis", renderMode: "richText", formatter: (items: { dataIndex: number }[]) => {
        const day = days[items[0]?.dataIndex];
        if (!day) return "";
        const due = obligations.filter(item => item.date === day.date).map(item => `\n${item.name}: ${item.amount}`).join("");
        return `${day.date}\nExpected ${currency} ${day.expected.toFixed(2)}\nConservative ${currency} ${day.conservative.toFixed(2)}${compare ? `\n${compare.name} ${currency} ${compare.values[items[0].dataIndex]?.toFixed(2)}` : ""}${due}`;
      } },
      xAxis: { type: "category", boundaryGap: false, data: days.map(day => day.date), axisLabel: { color: muted }, axisLine: { lineStyle: { color: border } } },
      yAxis: { type: "value", scale: true, axisLabel: { color: muted }, splitLine: { lineStyle: { color: border, type: "dashed" } } },
      series: [
        { name: "Conservative", type: "line", stack: "band", symbol: "none", lineStyle: { opacity: 0 }, data: days.map(day => day.conservative) },
        { name: "Range", type: "line", stack: "band", symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: brand, opacity: 0.12 },
          data: days.map(day => day.optimistic - day.conservative) },
        { name: "Expected", type: "line", symbol: "none", lineStyle: { color: brand, width: 2.5 }, data: days.map(day => day.expected) },
        ...(compare ? [{ name: compare.name, type: "line", symbol: "none", lineStyle: { color: muted, width: 1.5, type: "dashed" }, data: compare.values }] : []),
        { name: "Obligations", type: "scatter", symbolSize: 9, itemStyle: { color: muted }, tooltip: { show: false },
          data: [...new Set(obligations.map(item => item.date))].filter(date => expectedOn.has(date)).map(date => [date, expectedOn.get(date)]) },
      ],
    }} />
  </div>;
}

const SERIES_COLORS = ["#2a6fdb", "#e07b39", "#3aa676", "#c94f6d", "#8a63d2", "#c9a227", "#2bb3c0", "#7a8699", "#d16ba5", "#5c9e31", "#b5651d", "#4b5bb5"];

/** Renders a validated model-written chart. Tooltips use rich text, so labels never render as HTML. */
export function AnswerChart({ spec }: { spec: ChartSpec }) {
  const colors = useThemeColors();
  const axis = { axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.muted }, splitLine: { lineStyle: { color: colors.border } } };
  const labels = spec.x ?? spec.series[0].data.map((_, index) => String(index + 1));
  const option = spec.type === "pie"
    ? { color: SERIES_COLORS, tooltip: { trigger: "item", renderMode: "richText", formatter: (item: { name: string; value: number; percent: number }) => `${item.name}: ${chartValue(item.value, spec.series[0])} (${item.percent}%)` },
      series: [{ type: "pie", radius: ["40%", "70%"], label: { color: colors.muted }, data: labels.map((name, index) => ({ name: String(name), value: spec.series[0].data[index] })) }] }
    : { color: SERIES_COLORS, grid: { left: 8, right: 16, top: spec.series.length > 1 ? 36 : 16, bottom: 8, containLabel: true },
      legend: spec.series.length > 1 ? { textStyle: { color: colors.muted } } : undefined,
      tooltip: { trigger: spec.type === "scatter" ? "item" : "axis", renderMode: "richText", valueFormatter: (value: number) => chartValue(value, spec.series.length === 1 ? spec.series[0] : {}) },
      xAxis: { type: "category", data: labels.map(String), boundaryGap: spec.type === "bar" || spec.type === "scatter", ...axis },
      yAxis: { type: "value", ...axis },
      series: spec.series.map(item => ({ name: item.name, data: item.data, type: spec.type === "area" ? "line" : spec.type,
        ...(spec.stacked ? { stack: "total" } : {}), ...(spec.type === "area" ? { areaStyle: { opacity: 0.2 } } : {}),
        ...(spec.type === "line" || spec.type === "area" ? { showSymbol: item.data.length < 40 } : {}), ...(spec.type === "bar" ? { barMaxWidth: 28 } : {}) })) };
  return <figure className="ai-chart my-4 min-w-0 max-w-full rounded-xl border border-border bg-card p-4">
    {spec.title && <figcaption className="mb-2 text-sm font-medium">{spec.title}</figcaption>}
    <div role="img" aria-label={spec.title ?? `${spec.type} chart of ${spec.series.map(item => item.name).join(", ")}`}>
      <ReactECharts option={option} style={{ height: 280 }} />
    </div>
  </figure>;
}
