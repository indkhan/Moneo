"use client";

import ReactECharts from "echarts-for-react";

export function SpendingChart({ values }: { values: number[] }) {
  return (
    <ReactECharts
      option={{
        xAxis: { type: "category", data: values.map((_, i) => `W${i + 1}`) },
        yAxis: { type: "value" },
        series: [{ type: "bar", data: values }],
      }}
      style={{ height: 280 }}
    />
  );
}
