import Link from "next/link";
import { requireWorkspace } from "@/lib/auth";
import { backendHealth } from "@/lib/backend-health";
import { cronSecret, isDesktopRuntime, moneoVersion } from "@/lib/env";
import { displayFormat } from "@/lib/display-format";
import { SummaryRuns, type SummaryRun } from "./summary-runs";

const card = "rounded-xl border border-border bg-card p-6";
const JOBS = 10;

export async function BackendStatus() {
  const checks = await backendHealth();
  if (!checks) return <p role="alert" className="mt-3 text-sm text-warning">The backend is not configured, so its services cannot be checked.</p>;
  return <ul className="mt-3 divide-y divide-border text-sm">
    {checks.map(check => <li key={check.name} className="flex items-center justify-between gap-3 py-2">
      <span>{check.name}</span>
      <span className={check.ok ? "text-success" : "text-danger"}>{check.ok ? `Running · ${check.ms} ms` : "Not reachable"}</span>
    </li>)}
  </ul>;
}

export function AppBuild() {
  return <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
    <div><dt className="text-muted-foreground">Version</dt><dd>{moneoVersion() ?? "Not set"}</dd></div>
    <div><dt className="text-muted-foreground">Installed as</dt><dd>{isDesktopRuntime() ? "Desktop app" : "Source installation (Docker)"}</dd></div>
  </dl>;
}

export async function RecentJobs() {
  const { supabase, workspace, settings } = await requireWorkspace();
  const { dateTime } = displayFormat(workspace.locale, settings.timezone);
  const { data, error } = await supabase.from("background_jobs").select("id, kind, status, stage, error, created_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(JOBS);
  if (error) return <p role="alert" className="mt-3 text-sm text-danger">Background jobs are unavailable. Try again later.</p>;
  if (!data.length) return <p className="mt-3 text-sm text-muted-foreground">No background jobs yet.</p>;
  return <ul className="mt-3 divide-y divide-border text-sm">
    {data.map(job => <li key={job.id} className="py-2">
      <p className="flex flex-wrap justify-between gap-2"><span className="font-medium capitalize">{job.kind.replaceAll("_", " ")}</span><span className="text-muted-foreground">{dateTime(job.created_at)}</span></p>
      <p className={`capitalize ${job.status === "failed" ? "text-danger" : "text-muted-foreground"}`}>{job.status} · {job.stage.replaceAll("_", " ")}</p>
      {job.error && <details className="mt-1 text-xs text-muted-foreground"><summary className="cursor-pointer">Technical details</summary><p className="mt-1 break-words">{job.error}</p></details>}
    </li>)}
  </ul>;
}

export async function ScheduledSummaries() {
  const { supabase, workspace } = await requireWorkspace();
  const scheduled = await supabase.from("summary_runs").select("id,job_id,cadence,period_start").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(5);
  const jobs = scheduled.data?.length ? await supabase.from("background_jobs").select("id,status,stage,error").eq("workspace_id", workspace.id).in("id", scheduled.data.map(run => run.job_id)) : null;
  if (scheduled.error || jobs?.error) return <p role="alert" className="mt-3 text-sm text-danger">Scheduled status is unavailable. Try again later.</p>;
  const runs: SummaryRun[] = scheduled.data.map(run => {
    const job = jobs?.data?.find(item => item.id === run.job_id);
    return { ...run, status: job?.status ?? "unknown", stage: job?.stage ?? "unavailable", error: job?.error ?? null };
  });
  return <>
    {!cronSecret() && <p className="mt-3 text-sm text-warning">Automatic scheduling is not configured, so summaries will not start on their own.</p>}
    <SummaryRuns initial={runs} locale={workspace.locale} />
  </>;
}

export async function Connections() {
  const { supabase, workspace, settings } = await requireWorkspace();
  const { dateTime } = displayFormat(workspace.locale, settings.timezone);
  const [banks, scalable] = await Promise.all([
    supabase.from("bank_connections").select("id, aspsp_name, status, last_synced_at, last_error").eq("workspace_id", workspace.id).neq("status", "pending"),
    supabase.from("scalable_connections").select("id, status, last_synced_at, last_error").eq("workspace_id", workspace.id).neq("status", "pending"),
  ]);
  if (banks.error || scalable.error) return <p role="alert" className="mt-3 text-sm text-danger">Connection status is unavailable. Try again later.</p>;
  const rows = [...banks.data.map(bank => ({ ...bank, name: bank.aspsp_name })), ...scalable.data.map(item => ({ ...item, name: "Scalable Capital" }))];
  return <>
    {rows.length ? <ul className="mt-3 divide-y divide-border text-sm">
      {rows.map(row => <li key={row.id} className="py-2">
        <p className="flex flex-wrap justify-between gap-2"><span className="font-medium">{row.name}</span><span className="text-muted-foreground">{row.last_synced_at ? `Last synced ${dateTime(row.last_synced_at)}` : "Never synced"}</span></p>
        <p className={`capitalize ${row.last_error ? "text-danger" : "text-muted-foreground"}`}>{row.status.replaceAll("_", " ")}{row.last_error ? ` · ${row.last_error}` : ""}</p>
      </li>)}
    </ul> : <p className="mt-3 text-sm text-muted-foreground">No bank or Scalable connection.</p>}
    <p className="mt-3 text-sm"><Link href="/money/accounts#connected" className="underline">Manage connections on Accounts</Link></p>
  </>;
}

export function HealthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className={card}><h3 className="text-sm font-medium">{title}</h3>{children}</section>;
}
