"use client";

import ReactECharts from "echarts-for-react";

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
