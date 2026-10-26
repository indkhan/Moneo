"use client";

import { Component, useMemo, useSyncExternalStore, type ReactNode } from "react";
import dynamic from "next/dynamic";

// Loaded on the client only, so echarts never ships in the server render or blocks first paint.
export const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

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
    const fallback = theme === "dark" ? { brand: "#cbf26b", muted: "#a3a39e", border: "#24262a", card: "#16171a", input: "#3987e5", output: "#d95926" } : { brand: "#4a6400", muted: "#5c5d58", border: "#e2e0d8", card: "#ffffff", input: "#2a78d6", output: "#eb6834" };
    return { brand: token("--color-brand", fallback.brand), muted: token("--color-muted-foreground", fallback.muted), border: token("--color-border", fallback.border), card: token("--color-card", fallback.card), input: token("--color-chart-input", fallback.input), output: token("--color-chart-output", fallback.output) };
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

type ForecastChartDay = { date: string; expected: number; conservative: number; optimistic: number };
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

// Lime, violet and coral lead, as in the app; the rest stay distinguishable in both themes.
const SERIES_COLORS = ["#a6cf3f", "#9b87f5", "#f2875f", "#7a8699", "#4fb3bf", "#d9a93a", "#d16ba5", "#5c9e31", "#b5651d", "#4b5bb5", "#c94f6d", "#2a6fdb"];

/** Parses a model-written ```chart block: any ECharts option object, or null when it is not one. */
export function parseChartOption(source: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(source);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** Shows `fallback` instead of a chart that ECharts fails to render. */
export class ChartBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** Renders a model-written ECharts option with theme defaults; the model's own settings win. */
export function AnswerChart({ option }: { option: Record<string, unknown> }) {
  const colors = useThemeColors();
  const themed = { color: SERIES_COLORS, backgroundColor: "transparent", textStyle: { color: colors.muted }, tooltip: {}, ...option };
  const title = (option.title as { text?: unknown } | undefined)?.text;
  return <figure className="ai-chart my-4 min-w-0 max-w-full rounded-xl border border-border bg-card p-4">
    <div role="img" aria-label={typeof title === "string" ? title : "Chart"}>
      <ReactECharts option={themed} notMerge style={{ width: "100%", height: 320 }} />
    </div>
  </figure>;
}
