"use client";

import { ReactECharts, useThemeColors } from "@/components/chart";
import type { ModelUsage } from "@/lib/ai/usage";

// One horizontal bar per model, split into input and output tokens. Models are ordered largest first.
export function UsageChart({ models, locale }: { models: ModelUsage[]; locale: string }) {
  const colors = useThemeColors();
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);
  const axis = { axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.muted }, splitLine: { lineStyle: { color: colors.border, type: "dashed" } } };
  const segment = { barMaxWidth: 28, itemStyle: { borderColor: colors.card, borderWidth: 2 } };
  const summary = models.map(model => `${model.model_id}: ${format(model.input_tokens + model.output_tokens)} tokens`).join("; ");
  return (
    <div>
      <div role="img" aria-label={`Tokens per model. ${summary}`}>
        <ReactECharts
          style={{ height: Math.max(160, models.length * 56 + 64) }}
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
        />
      </div>
      <details className="mt-3 text-sm text-muted-foreground">
        <summary className="cursor-pointer">View as table</summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <thead><tr className="border-b border-border"><th className="py-1.5 font-medium">Model</th><th className="py-1.5 text-right font-medium">Requests</th><th className="py-1.5 text-right font-medium">Input</th><th className="py-1.5 text-right font-medium">Output</th><th className="py-1.5 text-right font-medium">Total</th></tr></thead>
          <tbody>{models.map(model => <tr key={model.model_id} className="border-b border-border last:border-0">
            <th scope="row" className="py-1.5 font-normal break-all text-foreground">{model.model_id}</th>
            <td className="py-1.5 text-right">{format(model.requests)}</td>
            <td className="py-1.5 text-right">{format(model.input_tokens)}</td>
            <td className="py-1.5 text-right">{format(model.output_tokens)}</td>
            <td className="py-1.5 text-right">{format(model.input_tokens + model.output_tokens)}</td>
          </tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}
