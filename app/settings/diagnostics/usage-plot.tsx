"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useThemeColors } from "@/components/chart-theme";

const ReactECharts = dynamic(() => import("@/components/finance-echarts"), { ssr: false });

export type UsageBar = { label: string; input: number; output: number };

export function UsagePlot({ bars, locale, by, layout }: { bars: UsageBar[]; locale: string; by: string; layout: "rows" | "columns" }) {
  const colors = useThemeColors();
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);
  const axis = { axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.muted }, splitLine: { lineStyle: { color: colors.border, type: "dashed" } } };
  const segment = { barMaxWidth: 28, itemStyle: { borderColor: colors.card, borderWidth: 2 } };
  const summary = bars.map(bar => `${bar.label}: ${format(bar.input + bar.output)} tokens`).join("; ");
  const anchor = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const height = layout === "rows" ? Math.max(160, bars.length * 56 + 64) : 240;
  useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      setVisible(true);
    }, { rootMargin: "300px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const values = { type: "value" as const, ...axis, axisLabel: { color: colors.muted, formatter: format } };
  const categories = { type: "category" as const, data: bars.map(bar => bar.label), ...axis };
  const lastCorner = layout === "rows" ? [0, 4, 4, 0] : [4, 4, 0, 0];
  return <div ref={anchor} role="img" aria-label={`Tokens per ${by}. ${summary}`} style={{ height }}>
    {visible && <ReactECharts
      style={{ height }}
      option={{
        grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
        legend: { top: 0, textStyle: { color: colors.muted } },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: format },
        ...layout === "rows" ? { xAxis: values, yAxis: { ...categories, inverse: true } } : { xAxis: categories, yAxis: values },
        series: [
          { ...segment, name: "Input", type: "bar", stack: "tokens", data: bars.map(bar => bar.input), color: colors.input },
          { ...segment, name: "Output", type: "bar", stack: "tokens", data: bars.map(bar => bar.output), color: colors.output, itemStyle: { ...segment.itemStyle, borderRadius: lastCorner } },
        ],
      }}
    />}
  </div>;
}
