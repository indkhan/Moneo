import { Suspense } from "react";
import { BUILTIN_WIDGETS, dashboardItems, dashboardLayoutSchema } from "@/lib/finance/dashboard";
import { saveDashboard } from "../dashboard-actions";
import { InsightSettings } from "./insights";
import { requireWorkspace } from "@/lib/auth";
import { SkeletonCard } from "@/components/skeleton";
import { SettingsForm } from "./form";
import { SummaryRuns, type SummaryRun } from "./summary-runs";
import { ResetData } from "./reset";
import { ConnectedBanks } from "@/components/connected-banks";

type Workspace = Awaited<ReturnType<typeof requireWorkspace>>;
const card = "scroll-mt-20 rounded-xl border border-border bg-card p-6";
const sectionNav = [
  ["display", "Display and calendar"], ["ai", "AI and your data"], ["insights", "Insights and summaries"], ["relevance", "Insight relevance"],
  ["home", "Customize Home"], ["banks", "Connected banks"], ["summaries", "Scheduled summaries"], ["usage", "AI usage"], ["danger", "Danger zone"],
] as const;

async function loadDashboard({ supabase, workspace }: Workspace) {
  const layout = await supabase.from("dashboard_layouts").select("items, version").eq("workspace_id", workspace.id).maybeSingle();
  if (layout.error) throw layout.error;
  const parsedLayout = layout.data ? dashboardLayoutSchema.safeParse(layout.data.items) : null;
  const ordered = dashboardItems(parsedLayout?.success ? parsedLayout.data : null);
  return { version: layout.data?.version ?? 0, ordered, choices: [...new Set([...ordered, ...Object.keys(BUILTIN_WIDGETS)])] };
}

async function loadRuns({ supabase, workspace }: Workspace): Promise<SummaryRun[] | null> {
  const scheduled = await supabase.from("summary_runs").select("id,job_id,cadence,period_start").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(5);
  if (scheduled.error) return null;
  const jobs = scheduled.data.length ? await supabase.from("background_jobs").select("id,status,stage,error").eq("workspace_id", workspace.id).in("id", scheduled.data.map(run => run.job_id)) : null;
  if (jobs?.error) return null;
  return scheduled.data.map(run => {
    const job = jobs?.data?.find(job => job.id === run.job_id);
    return { ...run, status: job?.status ?? "unknown", stage: job?.stage ?? "unavailable", error: job?.error ?? null };
  });
}

export default async function SettingsPage() {
  const context = await requireWorkspace();
  const { user, workspace, settings } = context;
  const [dashboard, runs] = await Promise.all([loadDashboard(context), loadRuns(context)]);
  return <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 lg:py-10">
    <div><h1 className="page-title">Settings</h1><p className="mt-1 break-words text-sm text-muted-foreground">Your private workspace · {user.email ?? "Signed in"}</p></div>
    <div className="mt-8 grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label="Settings sections" className="lg:sticky lg:top-20 lg:self-start">
        <ul className="flex flex-wrap gap-1 lg:flex-col">{sectionNav.map(([id, label]) => <li key={id}>
          <a href={`#${id}`} className={`block rounded-md px-2.5 py-1.5 text-sm hover:bg-muted hover:text-foreground ${id === "danger" ? "text-red-700" : "text-muted-foreground"}`}>{label}</a>
        </li>)}</ul>
      </nav>
      <div className="min-w-0 space-y-8">
        <SettingsForm settings={settings} currency={workspace.display_currency} />
        <div id="relevance" className="scroll-mt-20"><Suspense fallback={<SkeletonCard lines={4} />}><InsightSettings /></Suspense></div>
        <details id="home" className={card}><summary className="cursor-pointer text-base font-semibold">Customize Home</summary><form action={saveDashboard} className="mt-4 space-y-4"><input type="hidden" name="version" value={dashboard.version} />{dashboard.choices.map((key, index) => <div key={key} className="flex flex-wrap items-center gap-3 border-b border-border pb-3 last:border-0"><label className="flex flex-1 items-center gap-2 text-sm"><input type="checkbox" name="enabled" value={key} defaultChecked={dashboard.ordered.includes(key)} />{BUILTIN_WIDGETS[key as keyof typeof BUILTIN_WIDGETS]}</label><label className="flex items-center gap-2 text-sm">Position<input type="number" name={`position:${key}`} min="1" max="50" defaultValue={dashboard.ordered.includes(key) ? dashboard.ordered.indexOf(key) + 1 : index + 1} className="min-h-10 w-20 rounded-lg border border-border bg-card px-3 py-2 text-sm" /></label></div>)}<button className="min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Save dashboard</button><p className="text-sm text-muted-foreground">Lower positions appear first.</p></form></details>
        <div id="banks" className="scroll-mt-20"><ConnectedBanks /></div>
        <section id="summaries" className={card}><h2 className="text-base font-semibold">Scheduled summaries</h2>
          <p className="mt-1 text-sm text-muted-foreground">Recent summary runs. Change the schedule under Insights and summaries.</p>
          <details className="mt-2 text-sm text-muted-foreground"><summary className="cursor-pointer">More details</summary><p className="mt-2">Weekly summaries are due on Monday and monthly ones on the first, in your timezone and at your preferred time. A daily check starts due summaries, so they can arrive a day late. Turn summaries off to stop future runs, or stop an active run below.</p></details>
          {!process.env.CRON_SECRET && <p className="mt-3 text-sm text-amber-700">Automatic scheduling needs to be configured on the deployment. Your preference is saved.</p>}
          {runs ? <SummaryRuns initial={runs} /> : <p role="alert" className="mt-3 text-sm text-red-700">Scheduled status is unavailable. Try again later.</p>}
          <p className="mt-4 text-sm text-muted-foreground">Finished summaries appear in Activity. If one fails, run a new review from AI.</p>
        </section>
        <section id="usage" className={card}><h2 className="text-base font-semibold">AI usage</h2><p className="mt-1 text-sm text-muted-foreground">Usage appears in Activity when the provider reports it. Missing figures are shown as unknown, not zero.</p></section>
        <div id="danger" className="scroll-mt-20"><ResetData /></div>
      </div>
    </div>
  </main>;
}
