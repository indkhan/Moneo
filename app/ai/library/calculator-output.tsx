"use client";

import dynamic from "next/dynamic";
import { CalculatorRows, outputLabel, outputValue } from "./calculator-rows";

const Chart = dynamic(() => import("@/components/chart").then(module => module.SpendingChart), {
  ssr: false,
  loading: () => <div className="h-[220px] rounded-lg bg-muted" />,
});

export type CalculatorOutput = {
  summary?: string;
  rows?: { id?: string; name?: string; [k: string]: unknown }[];
  numbers?: Record<string, string | number>;
  chart?: { labels?: string[]; values?: number[]; type?: unknown; label?: unknown };
  unavailable?: string;
  warning?: string;
};

// Shared renderer for saved calculators and editor previews: generated code only
// supplies JSON; all markup and money formatting stay in host code.
export function CalculatorOutputView({ output, currency, locale }: { output: CalculatorOutput; currency?: string; locale?: string }) {
  const code = typeof output.numbers?.currency === "string" && /^[A-Z]{3}$/.test(output.numbers.currency) ? output.numbers.currency : currency;
  const numbers = Object.entries(output.numbers ?? {}).filter(([key]) => key !== "currency" || code !== output.numbers?.currency);
  const chart = output.chart?.labels && output.chart?.values ? output.chart : null;
  return (
    <div className="space-y-4 text-sm">
      {output.unavailable && <p className="rounded-lg border border-border bg-muted px-4 py-3 text-muted-foreground">{output.unavailable}</p>}
      {output.summary && <p className="text-base font-semibold leading-snug tracking-tight text-foreground">{output.summary}</p>}
      {output.warning && <p className="text-amber-700">Note: {output.warning}</p>}
      {numbers.length > 0 && (
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {numbers.map(([key, value]) => (
            <div key={key} className="min-w-0 rounded-lg border border-border bg-background px-3 py-2.5">
              <dt className="truncate text-xs text-muted-foreground" title={key}>{outputLabel(key)}</dt>
              <dd className="mt-1 break-words text-lg font-semibold tabular-nums text-foreground">{outputValue(key, value, code, locale)}</dd>
            </div>
          ))}
        </dl>
      )}
      {chart && (
        <div className="rounded-lg border border-border bg-background p-3">
          {typeof chart.label === "string" && <p className="mb-1 text-xs text-muted-foreground">{chart.label}</p>}
          <Chart labels={chart.labels} values={chart.values!} type={chart.type === "line" ? "line" : "bar"} height={220}
            ariaLabel={typeof chart.label === "string" ? chart.label : "Generated calculator chart"} />
        </div>
      )}
      {output.rows && output.rows.length > 0 && <CalculatorRows rows={output.rows} locale={locale} currency={code} />}
    </div>
  );
}
