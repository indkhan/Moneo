"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useThemeColors } from "@/components/chart-theme";
import type { ModelUsage } from "@/lib/ai/usage";

const ReactECharts = dynamic(() => import("@/components/finance-echarts"), { ssr: false });

export function UsagePlot({ models, locale }: { models: ModelUsage[]; locale: string }) {
  const colors = useThemeColors();
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);
  const axis = { axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.muted }, splitLine: { lineStyle: { color: colors.border, type: "dashed" } } };
  const segment = { barMaxWidth: 28, itemStyle: { borderColor: colors.card, borderWidth: 2 } };
  const summary = models.map(model => `${model.model_id}: ${format(model.input_tokens + model.output_tokens)} tokens`).join("; ");
  const anchor = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const height = Math.max(160, models.length * 56 + 64);
  useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      setVisible(true);
    }, { rootMargin: "300px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={anchor} role="img" aria-label={`Tokens per model. ${summary}`} style={{ height }}>
    {visible && <ReactECharts
          style={{ height }}
          option={{
            grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
            legend: { top: 0, textStyle: { color: colors.muted } },
            tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: format },
            xAxis: { type: "value", ...axis, axisLabel: { color: colors.muted, formatter: format } },
            yAxis: { type: "category", inverse: true, data: models.map(model => model.model_id), ...axis },
            series: [
              { ...segment, name: "Input", type: "bar", stack: "tokens", data: models.map(model => model.input_tokens), color: colors.input },
              { ...segment, name: "Output", type: "bar", stack: "tokens", data: models.map(model => model.output_tokens), color: colors.output, itemStyle: { ...segment.itemStyle, borderRadius: [0, 4, 4, 0] } },
            ],
          }}
        />}
  </div>;
}
