import { Suspense } from "react";
import { InsightSettings } from "./insights";
import { requireWorkspace } from "@/lib/auth";
import { SkeletonCard } from "@/components/skeleton";
import { SettingsForm } from "./form";
import { SummaryRuns, type SummaryRun } from "./summary-runs";
import { ResetData } from "./reset";
import { ConnectedBanks } from "@/components/connected-banks";
import { ScalableConnection } from "@/components/scalable-connection";
import { AiUsage } from "./ai-usage";
import { AiAccess } from "./ai-access";
import { SetupSecrets } from "./setup-secrets";
import { PhoneAccessSection } from "./phone-access";
import { parseUsageWindow } from "@/lib/ai/usage";
import { desktopUpdate, isDesktop } from "@/lib/desktop-bridge";
import { AppUpdate } from "./app-update";

export const metadata = { title: "Settings" };

type Workspace = Awaited<ReturnType<typeof requireWorkspace>>;
const card = "scroll-mt-20 rounded-xl border border-border bg-card p-6";
const sectionNav = [
  ["updates", "App updates"], ["connections", "Keys and connections"], ["display", "Display and calendar"], ["ai", "AI and your data"], ["insights", "Insights and summaries"], ["relevance", "Insight relevance"],
  ["summaries", "Scheduled summaries"], ["usage", "AI chat tokens"], ["danger", "Danger zone"],
] as const;

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

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ usage?: string; chatgpt?: string }> }) {
  const context = await requireWorkspace();
  const query = await searchParams;
  const usageWindow = parseUsageWindow(query.usage);
  const { workspace, settings } = context;
  const [runs, update] = await Promise.all([loadRuns(context), isDesktop() ? desktopUpdate("status").catch(() => null) : null]);
  return <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-8 lg:py-8">
    <div className="flex flex-col gap-1"><p className="eyebrow">Workspace</p><h1 className="page-title">Settings</h1><p className="mt-1 break-words text-sm text-muted-foreground">Your private, self-hosted workspace</p></div>
    <div className="mt-8 grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label="Settings sections" className="lg:sticky lg:top-24 lg:self-start">
        <ul className="flex flex-wrap gap-1 lg:flex-col">{sectionNav.filter(([id]) => id !== "updates" || update).map(([id, label]) => <li key={id}>
          <a href={`#${id}`} className={`block rounded-md px-2.5 py-1.5 text-sm hover:bg-muted hover:text-foreground ${id === "danger" ? "text-danger" : "text-muted-foreground"}`}>{label}</a>
        </li>)}</ul>
      </nav>
      <div className="min-w-0 space-y-8">
        {update && <AppUpdate initial={update} />}
        <section id="connections" aria-labelledby="connections-title" className="scroll-mt-20 space-y-4">
          <div><h2 id="connections-title" className="text-base font-semibold">Keys and connections</h2>
            <p className="mt-1 text-sm text-muted-foreground">Every key and outside service Moneo uses is set up here. Keys are checked before they are saved and stored encrypted in your database; there is no file to edit.</p></div>
          <AiAccess message={query.chatgpt} />
          <div id="banks" className="scroll-mt-20"><ConnectedBanks /></div>
          <div id="scalable" className="scroll-mt-20"><ScalableConnection /></div>
          <div id="phone" className="scroll-mt-20"><Suspense fallback={<SkeletonCard lines={2} />}><PhoneAccessSection /></Suspense></div>
          <SetupSecrets />
        </section>
        <SettingsForm settings={settings} currency={workspace.display_currency} timeZones={[...new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])]} />
        <div id="relevance" className="scroll-mt-20"><Suspense fallback={<SkeletonCard lines={4} />}><InsightSettings /></Suspense></div>
        <section id="summaries" className={card}><h2 className="text-sm font-medium">Scheduled summaries</h2>
          <p className="mt-1 text-sm text-muted-foreground">Recent summary runs. Change the schedule under Insights and summaries.</p>
          <details className="mt-2 text-sm text-muted-foreground"><summary className="cursor-pointer">More details</summary><p className="mt-2">Weekly summaries are due on Monday and monthly ones on the first, in your timezone and at your preferred time. A daily check starts due summaries, so they can arrive a day late. Turn summaries off to stop future runs, or stop an active run below.</p></details>
          {!process.env.CRON_SECRET && <p className="mt-3 text-sm text-warning">Automatic scheduling needs to be configured on the deployment. Your preference is saved.</p>}
          {runs ? <SummaryRuns initial={runs} locale={settings.locale} /> : <p role="alert" className="mt-3 text-sm text-danger">Scheduled status is unavailable. Try again later.</p>}
          <p className="mt-4 text-sm text-muted-foreground">Finished summaries appear in the Activity log. If one fails, run a new review from AI.</p>
        </section>
        <section id="usage" className={card}><h2 className="text-sm font-medium">AI chat token usage</h2><p className="mt-1 text-sm text-muted-foreground">Tokens used by AI chat, per model; other AI tasks are not included. Requests the provider did not report are left out, not counted as zero. Moneo does not record costs: see actual charges with your provider, at <a href="https://platform.openai.com/usage" target="_blank" rel="noreferrer" className="underline hover:text-foreground">OpenAI</a> or <a href="https://openrouter.ai/activity" target="_blank" rel="noreferrer" className="underline hover:text-foreground">OpenRouter</a>.</p><Suspense fallback={<SkeletonCard lines={4} />}><AiUsage window={usageWindow} /></Suspense></section>
        <div id="danger" className="scroll-mt-20 space-y-8"><ResetData /></div>
      </div>
    </div>
  </main>;
}
