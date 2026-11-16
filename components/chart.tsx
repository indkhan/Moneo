"use client";

import { useMemo, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { formatCompactMoney, formatMoney } from "@/lib/finance/format";

export const ReactECharts = dynamic(() => import("./echarts-lean"), { ssr: false });
if (typeof window !== "undefined") void import("./echarts-lean");

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function token(name: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color || fallback;
}

export function useThemeColors() {
  const theme = useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.theme ?? "light", () => "light");
  return useMemo(() => {
    const fallback = theme === "dark" ? { brand: "#cbf26b", muted: "#a3a39e", border: "#24262a", card: "#16171a", input: "#3987e5", output: "#d95926", out: "#5b5d62", foreground: "#eeece6" } : { brand: "#4a6400", muted: "#5c5d58", border: "#e2e0d8", card: "#ffffff", input: "#2a78d6", output: "#eb6834", out: "#a9aaa3", foreground: "#141413" };
    return { brand: token("--color-brand", fallback.brand), muted: token("--color-muted-foreground", fallback.muted), border: token("--color-border", fallback.border), card: token("--color-card", fallback.card), input: token("--color-chart-input", fallback.input), output: token("--color-chart-output", fallback.output), out: token("--color-chart-out", fallback.out), foreground: token("--color-foreground", fallback.foreground) };
  }, [theme]);
}

export function CashFlowChart({ labels, income, spending, currency, locale, flow, selected, picked, height = 240, onSelect }: {
  labels: string[]; income: bigint[]; spending: bigint[]; currency: string; locale?: string; flow?: "in" | "out"; selected?: number; picked?: "in" | "out"; height?: number;
  onSelect?: (index: number, flow: "in" | "out") => void;
}) {
  const colors = useThemeColors();
  const bar = { type: "bar", barMaxWidth: 28, barGap: "20%", itemStyle: { borderRadius: [4, 4, 0, 0] } };
  const points = (values: bigint[]) => values.map((amount, index) => selected === undefined || index === selected ? Number(amount) : { value: Number(amount), itemStyle: { opacity: 0.35 } });
  const exact: Record<string, bigint[]> = { In: income, Out: spending };
  const marker = (side: "in" | "out") => selected !== undefined && picked === side
    ? { markLine: { symbol: "none", silent: true, label: { show: false }, lineStyle: { type: "dashed", color: colors.muted, width: 1.5 }, data: [{ xAxis: labels[selected] }] } } : {};
  const series = [
    ...(flow !== "out" ? [{ ...bar, name: "In", data: points(income), itemStyle: { ...bar.itemStyle, color: colors.brand }, ...marker("in") }] : []),
    ...(flow !== "in" ? [{ ...bar, name: "Out", data: points(spending), itemStyle: { ...bar.itemStyle, color: colors.out }, ...marker("out") }] : []),
  ];
  return <div role="img" aria-label="Money in and out for each of the last six months" style={{ height }}>
    <ReactECharts
      notMerge
      option={{
        grid: { left: 0, right: 0, top: 8, bottom: 0, containLabel: true },
        tooltip: { trigger: "axis", formatter: (items: { dataIndex: number; seriesName: string; marker: string }[]) =>
          `${labels[items[0].dataIndex]}${items.map(item => `<br/>${item.marker}${item.seriesName} <b>${formatMoney(exact[item.seriesName][item.dataIndex], currency, locale)}</b>`).join("")}` },
        xAxis: { type: "category", data: labels, axisLine: { lineStyle: { color: colors.border } }, axisTick: { show: false }, axisLabel: { color: colors.muted, fontFamily: "monospace" } },
        yAxis: { type: "value", axisLabel: { show: false }, splitLine: { lineStyle: { color: colors.border, type: "dashed" } } },
        series,
      }}
      style={{ height, cursor: onSelect ? "pointer" : undefined }}
      onEvents={onSelect ? { click: (event: { dataIndex: number; seriesName: string }) => onSelect(event.dataIndex, event.seriesName === "In" ? "in" : "out") } : undefined}
    />
  </div>;
}

type ForecastChartDay = { date: string; expected: bigint; conservative: bigint; optimistic: bigint };
type ForecastChartObligation = { date: string; name: string; amount: string };

export function ForecastChart({ days, obligations, currency, locale, label, compare }: {
  days: ForecastChartDay[]; obligations: ForecastChartObligation[]; currency: string; locale?: string; label: string;
  compare?: { name: string; values: bigint[] };
}) {
  const brand = token("--color-brand", "#cbf26b"), muted = token("--color-muted-foreground", "#a3a39e"), border = token("--color-border", "#24262a");
  const expectedOn = new Map(days.map(day => [day.date, Number(day.expected)]));
  const money = (amount: bigint) => formatMoney(amount, currency, locale);
  return <div role="img" aria-label={label}>
    <ReactECharts style={{ height: 260 }} option={{
      grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
      tooltip: { trigger: "axis", renderMode: "richText", formatter: (items: { dataIndex: number }[]) => {
        const index = items[0]?.dataIndex, day = days[index];
        if (!day) return "";
        const due = obligations.filter(item => item.date === day.date).map(item => `
${item.name}: ${item.amount}`).join("");
        return `${day.date}
Expected ${money(day.expected)}
Conservative ${money(day.conservative)}${compare ? `
${compare.name} ${money(compare.values[index])}` : ""}${due}`;
      } },
      xAxis: { type: "category", boundaryGap: false, data: days.map(day => day.date), axisLabel: { color: muted }, axisLine: { lineStyle: { color: border } } },
      yAxis: { type: "value", scale: true, axisLabel: { color: muted, formatter: (value: number) => formatCompactMoney(BigInt(Math.round(value)), currency, locale) }, splitLine: { lineStyle: { color: border, type: "dashed" } } },
      series: [
        { name: "Conservative", type: "line", stack: "band", symbol: "none", lineStyle: { opacity: 0 }, data: days.map(day => Number(day.conservative)) },
        { name: "Range", type: "line", stack: "band", symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: brand, opacity: 0.12 },
          data: days.map(day => Number(day.optimistic - day.conservative)) },
        { name: "Expected", type: "line", symbol: "none", lineStyle: { color: brand, width: 2.5 }, data: days.map(day => Number(day.expected)) },
        ...(compare ? [{ name: compare.name, type: "line", symbol: "none", lineStyle: { color: muted, width: 1.5, type: "dashed" }, data: compare.values.map(Number) }] : []),
        { name: "Obligations", type: "scatter", symbolSize: 9, itemStyle: { color: muted }, tooltip: { show: false },
          data: [...new Set(obligations.map(item => item.date))].filter(date => expectedOn.has(date)).map(date => [date, expectedOn.get(date)]) },
      ],
    }} />
  </div>;
}
