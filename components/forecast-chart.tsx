"use client";

import dynamic from "next/dynamic";
import { formatCompactMoney, formatMoney } from "@/lib/finance/format";
import { useThemeColors } from "./chart-theme";

const ReactECharts = dynamic(() => import("./finance-echarts"), { ssr: false });

type ForecastChartDay = { date: string; expected: bigint; conservative: bigint; optimistic: bigint };
type ForecastChartObligation = { date: string; name: string; amount: string };

export function ForecastChart({ days, obligations, currency, locale, label, compare }: {
  days: ForecastChartDay[]; obligations: ForecastChartObligation[]; currency: string; locale?: string; label: string;
  compare?: { name: string; values: bigint[] };
}) {
  const { brand, muted, border } = useThemeColors();
  const expectedOn = new Map(days.map(day => [day.date, Number(day.expected)]));
  const money = (amount: bigint) => formatMoney(amount, currency, locale);
  return <div role="img" aria-label={label} className="h-[260px]">
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
