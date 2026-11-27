import { UsagePlot } from "./usage-plot";
import type { UsageGroup } from "@/lib/ai/usage";

export function UsageBreakdown({ title, groups, label, locale }: { title: string; groups: UsageGroup[]; label: (key: string) => string; locale: string }) {
  const number = new Intl.NumberFormat(locale);
  const format = (value: number) => number.format(value);
  const charted = groups.filter(group => group.input_tokens + group.output_tokens > 0);
  return <div className="min-w-0">
    <h3 className="text-sm font-medium">{title}</h3>
    {charted.length > 0 && <div className="mt-2"><UsagePlot by={title.toLowerCase()} layout="rows" locale={locale} bars={charted.map(group => ({ label: label(group.key), input: group.input_tokens, output: group.output_tokens }))} /></div>}
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[28rem] text-left text-sm tabular-nums text-muted-foreground">
        <thead><tr className="border-b border-border"><th className="py-1.5 font-medium">{title}</th><th className="py-1.5 text-right font-medium">Calls</th><th className="py-1.5 text-right font-medium">Failed</th><th className="py-1.5 text-right font-medium">Input</th><th className="py-1.5 text-right font-medium">Output</th><th className="py-1.5 text-right font-medium">Avg time</th></tr></thead>
        <tbody>{groups.map(group => <tr key={group.key} className="border-b border-border last:border-0">
          <th scope="row" className="py-1.5 font-normal break-all text-foreground">{label(group.key)}</th>
          <td className="py-1.5 text-right">{format(group.requests)}</td>
          <td className={`py-1.5 text-right ${group.failures ? "text-danger" : ""}`}>{format(group.failures)}</td>
          <td className="py-1.5 text-right">{format(group.input_tokens)}</td>
          <td className="py-1.5 text-right">{format(group.output_tokens)}</td>
          <td className="py-1.5 text-right">{group.average_duration_ms === null ? "—" : `${format(group.average_duration_ms)} ms`}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}
