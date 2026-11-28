import Link from "next/link";
import { requireWorkspace } from "@/lib/auth";
import { summarizeUsage, usageSince, usageWindows, type UsageLedgerRow, type UsageWindow } from "@/lib/ai/usage";
import { displayFormat } from "@/lib/display-format";
import { UsageBreakdown } from "./usage-chart";
import { UsagePlot } from "./usage-plot";
import { sourceLabel, taskLabel } from "./labels";

const ROW_LIMIT = 10_000;
const RECENT = 25;
const windowLabels: Record<UsageWindow, string> = { "7d": "7 days", "30d": "30 days", all: "All time" };
type LedgerRow = UsageLedgerRow & { id: string; conversation_id: string | null; job_id: string | null; agent_run_id: string | null; error_kind: string | null };

function callLink(row: LedgerRow) {
  if (row.conversation_id) return `/ai?conversation=${row.conversation_id}`;
  if (row.job_id) return `/ai/activity/${row.job_id}`;
  if (row.agent_run_id) return `/ai/agents/${row.agent_run_id}`;
  return null;
}

export async function AiUsage({ window }: { window: UsageWindow }) {
  const { supabase, workspace, settings } = await requireWorkspace();
  const since = usageSince(window);
  const base = supabase.from("ai_usage").select("id, created_at, task, model_id, source, status, error_kind, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, audio_seconds, duration_ms, conversation_id, job_id, agent_run_id")
    .eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(ROW_LIMIT);
  const { data, error } = await (since ? base.gte("created_at", since) : base);
  const period = (
    <nav aria-label="Usage period" className="mt-4 flex flex-wrap gap-1">
      {usageWindows.map(value => <Link key={value} href={`?usage=${value}#usage`} scroll={false} aria-current={value === window ? "page" : undefined}
        className={`rounded-md px-2.5 py-1 text-sm ${value === window ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{windowLabels[value]}</Link>)}
    </nav>
  );
  if (error || !data) return <>{period}<p role="alert" className="mt-3 text-sm text-danger">AI usage is unavailable. Try again later.</p></>;
  if (!data.length) return <>{period}<p className="mt-4 text-sm text-muted-foreground">No AI calls in this period.</p></>;
  const rows = data as LedgerRow[];
  const summary = summarizeUsage(rows, settings.timezone);
  const number = new Intl.NumberFormat(workspace.locale);
  const format = (value: number) => number.format(value);
  const { dateTime } = displayFormat(workspace.locale, settings.timezone);
  const { totals } = summary;
  const stats: [string, string][] = [
    ["Calls", format(totals.requests)], ["Failed", format(totals.failures)],
    ["Input tokens", format(totals.input_tokens)], ["Output tokens", format(totals.output_tokens)],
    ["Reasoning tokens", format(totals.reasoning_tokens)], ["Average time", totals.average_duration_ms === null ? "—" : `${format(totals.average_duration_ms)} ms`],
    ...totals.audio_seconds ? [["Audio processed", `${format(Math.round(totals.audio_seconds))} s`] as [string, string]] : [],
  ];
  return <>
    {period}
    <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map(([label, value]) => <div key={label} className="rounded-lg border border-border p-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd></div>)}
    </dl>
    {(totals.unreported > 0 || rows.length === ROW_LIMIT) && <p className="mt-3 text-sm text-muted-foreground">
      {totals.unreported ? `${format(totals.unreported)} ${totals.unreported === 1 ? "call" : "calls"} had no usage counts from the provider and ${totals.unreported === 1 ? "is" : "are"} not counted as zero. ` : ""}
      {rows.length === ROW_LIMIT ? `Showing the latest ${format(ROW_LIMIT)} calls.` : ""}
    </p>}
    <div className="mt-6">
      <h3 className="text-sm font-medium">Per day</h3>
      <div className="mt-2"><UsagePlot by="day" layout="columns" locale={workspace.locale} bars={summary.byDay.map(day => ({ label: day.day, input: day.input_tokens, output: day.output_tokens }))} /></div>
    </div>
    <div className="mt-6 grid gap-6 xl:grid-cols-2">
      <UsageBreakdown title="Task" groups={summary.byTask} label={taskLabel} locale={workspace.locale} />
      <UsageBreakdown title="Model" groups={summary.byModel} label={key => key} locale={workspace.locale} />
      <UsageBreakdown title="Provider" groups={summary.bySource} label={sourceLabel} locale={workspace.locale} />
    </div>
    <div className="mt-6">
      <h3 className="text-sm font-medium">Recent calls</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-sm tabular-nums text-muted-foreground">
          <thead><tr className="border-b border-border"><th className="py-1.5 font-medium">Time</th><th className="py-1.5 font-medium">Task</th><th className="py-1.5 font-medium">Model</th><th className="py-1.5 text-right font-medium">Token or audio usage</th><th className="py-1.5 text-right font-medium">Time taken</th><th className="py-1.5 pl-3 font-medium">Status</th></tr></thead>
          <tbody>{rows.slice(0, RECENT).map(row => {
            const link = callLink(row);
            const usage = row.input_tokens === null && row.output_tokens === null ? (row.audio_seconds === null ? "not reported" : `${format(Number(row.audio_seconds))} s audio`) : `${row.input_tokens === null ? "?" : format(row.input_tokens)} / ${row.output_tokens === null ? "?" : format(row.output_tokens)}`;
            return <tr key={row.id} className="border-b border-border last:border-0">
              <td className="py-1.5 whitespace-nowrap">{link ? <Link href={link} className="underline hover:text-foreground">{dateTime(row.created_at)}</Link> : dateTime(row.created_at)}</td>
              <td className="py-1.5 text-foreground">{taskLabel(row.task)}</td>
              <td className="py-1.5 break-all">{row.model_id} <span className="text-xs">· {sourceLabel(row.source)}</span></td>
              <td className="py-1.5 text-right">{usage}</td>
              <td className="py-1.5 text-right">{row.duration_ms === null ? "—" : `${format(row.duration_ms)} ms`}</td>
              <td className={`py-1.5 pl-3 ${row.status === "failed" ? "text-danger" : ""}`}>{row.status === "succeeded" ? "OK" : row.status === "canceled" ? "Stopped" : `Failed${row.error_kind ? ` (${row.error_kind})` : ""}`}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </div>
  </>;
}
