"use client";

import dynamic from "next/dynamic";
import { formatMoney } from "@/lib/finance/format";

import { useThemeColors } from "./chart-theme";

export { useThemeColors };

export const ReactECharts = dynamic(() => import("./echarts-lean"), { ssr: false });
if (typeof window !== "undefined") void import("./echarts-lean");

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
