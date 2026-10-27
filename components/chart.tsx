"use client";

import { useMemo, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";

// Loaded on the client only, so echarts never ships in the server render or blocks first paint.
// A trimmed echarts (see echarts-lean) serves app and chat charts alike.
export const ReactECharts = dynamic(() => import("./echarts-lean"), { ssr: false });
// Pages that import this module eagerly (Plan) start the echarts download before their chart renders.
if (typeof window !== "undefined") void import("./echarts-lean");

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** Resolves a color token to a concrete color; tokens are light-dark() pairs, which ECharts cannot parse. */
function token(name: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color || fallback;
}

// Chart colors follow the app's CSS tokens, including the dark theme.
export function useThemeColors() {
  const theme = useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.theme ?? "light", () => "light");
  return useMemo(() => {
    const fallback = theme === "dark" ? { brand: "#cbf26b", muted: "#a3a39e", border: "#24262a", card: "#16171a", input: "#3987e5", output: "#d95926", out: "#5b5d62" } : { brand: "#4a6400", muted: "#5c5d58", border: "#e2e0d8", card: "#ffffff", input: "#2a78d6", output: "#eb6834", out: "#a9aaa3" };
    return { brand: token("--color-brand", fallback.brand), muted: token("--color-muted-foreground", fallback.muted), border: token("--color-border", fallback.border), card: token("--color-card", fallback.card), input: token("--color-chart-input", fallback.input), output: token("--color-chart-output", fallback.output), out: token("--color-chart-out", fallback.out) };
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
  const axis = { axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.muted }, splitLine: { lineStyle: { color: colors.border, type: "dashed" } } };
  return (
    <div role={ariaLabel ? "img" : undefined} aria-label={ariaLabel}>
      <ReactECharts
        option={{
          color: [colors.brand],
          grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
          tooltip: { trigger: "axis", ...(formatValue ? { valueFormatter: formatValue } : {}) },
          xAxis: { type: "category", data: labels ?? values.map((_, i) => `W${i + 1}`), ...axis },
          yAxis: { type: "value", ...axis, ...(formatValue ? { axisLabel: { color: colors.muted, formatter: formatValue } } : {}) },
          series: [{ type, data: values, ...(type === "line" ? { smooth: true, showSymbol: false, areaStyle: { opacity: 0.12 } } : { barMaxWidth: 28, itemStyle: { borderRadius: [4, 4, 4, 4] } }) }],
        }}
        style={{ height, cursor: onSelect ? "pointer" : undefined }}
        onEvents={onSelect ? { click: (event: { dataIndex: number }) => onSelect(event.dataIndex) } : undefined}
      />
    </div>
  );
}

/** Money in vs money out per month; `flow` shows one side only. Bars are major units for pixel scale only. */
export function CashFlowChart({ labels, income, spending, flow, selected, picked, height = 240, formatValue, onSelect }: {
  labels: string[]; income: number[]; spending: number[]; flow?: "in" | "out"; selected?: number; picked?: "in" | "out"; height?: number;
  formatValue?: (value: number) => string; onSelect?: (index: number, flow: "in" | "out") => void;
}) {
  const colors = useThemeColors();
  const bar = { type: "bar", barMaxWidth: 28, barGap: "20%", itemStyle: { borderRadius: [4, 4, 0, 0] } };
  // With a month picked, the other months fade so the breakdown below clearly belongs to it.
  const points = (values: number[]) => values.map((value, index) => selected === undefined || index === selected ? value : { value, itemStyle: { opacity: 0.35 } });
  // The dashed line marks the picked month on the side (in or out) that was clicked.
  const marker = (side: "in" | "out") => selected !== undefined && picked === side
    ? { markLine: { symbol: "none", silent: true, label: { show: false }, lineStyle: { type: "dashed", color: colors.muted, width: 1.5 }, data: [{ xAxis: labels[selected] }] } } : {};
  const series = [
    ...(flow !== "out" ? [{ ...bar, name: "In", data: points(income), itemStyle: { ...bar.itemStyle, color: colors.brand }, ...marker("in") }] : []),
    ...(flow !== "in" ? [{ ...bar, name: "Out", data: points(spending), itemStyle: { ...bar.itemStyle, color: colors.out }, ...marker("out") }] : []),
  ];
  return <div role="img" aria-label="Money in and out for each of the last six months">
    <ReactECharts
      notMerge
      option={{
        grid: { left: 0, right: 0, top: 8, bottom: 0, containLabel: true },
        tooltip: { trigger: "axis", ...(formatValue ? { valueFormatter: formatValue } : {}) },
        xAxis: { type: "category", data: labels, axisLine: { lineStyle: { color: colors.border } }, axisTick: { show: false }, axisLabel: { color: colors.muted, fontFamily: "monospace" } },
        yAxis: { type: "value", axisLabel: { show: false }, splitLine: { lineStyle: { color: colors.border, type: "dashed" } } },
        series,
      }}
      style={{ height, cursor: onSelect ? "pointer" : undefined }}
      onEvents={onSelect ? { click: (event: { dataIndex: number; seriesName: string }) => onSelect(event.dataIndex, event.seriesName === "In" ? "in" : "out") } : undefined}
    />
  </div>;
}

type ForecastChartDay ={ date: string; expected: number; conservative: number; optimistic: number };
type ForecastChartObligation = { date: string; name: string; amount: string };

// Approximate chart coordinates (major units as numbers); exact amounts are rendered by the caller.
export function ForecastChart({ days, obligations, currency, label, compare }: {
  days: ForecastChartDay[]; obligations: ForecastChartObligation[]; currency: string; label: string;
  /** Optional second expected line, e.g. the real plan while a what-if scenario is shown. */
  compare?: { name: string; values: number[] };
}) {
  const brand = token("--color-brand", "#cbf26b"), muted = token("--color-muted-foreground", "#a3a39e"), border = token("--color-border", "#24262a");
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
