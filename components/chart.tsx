"use client";

import dynamic from "next/dynamic";

// Loaded on the client only, so echarts never ships in the server render or blocks first paint.
const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

export function SpendingChart({ values, labels, height = 280 }: { values: number[]; labels?: string[]; height?: number }) {
  return (
    <ReactECharts
      option={{
        grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
        tooltip: { trigger: "axis" },
        xAxis: { type: "category", data: labels ?? values.map((_, i) => `W${i + 1}`) },
        yAxis: { type: "value" },
        series: [{ type: "bar", data: values }],
      }}
      style={{ height }}
    />
  );
}

export type ForecastChartDay = { date: string; expected: number; conservative: number; optimistic: number };
export type ForecastChartObligation = { date: string; name: string; amount: string };

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
