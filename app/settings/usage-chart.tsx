import { UsagePlot } from "./usage-plot";
import type { ModelUsage } from "@/lib/ai/usage";

export function UsageChart({ models, locale }: { models: ModelUsage[]; locale: string }) {
  const number = new Intl.NumberFormat(locale);
  const format = (value: number) => number.format(value);
  return <div>
    <UsagePlot models={models} locale={locale} />
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
  </div>;
}
