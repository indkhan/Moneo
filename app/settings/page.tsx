import { InsightSettings } from "./insights";
import { requireWorkspace } from "@/lib/auth";
import { listFreeModels } from "@/lib/ai/provider";
import { SettingsForm } from "./form";
import { SummaryRuns } from "./summary-runs";

export default async function SettingsPage() {
  const { user, workspace, settings, supabase } = await requireWorkspace();
  const scheduled = await supabase.from("summary_runs").select("id,job_id,cadence,period_start").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(5);
  const jobs = scheduled.data?.length ? await supabase.from("background_jobs").select("id,status,stage,error").eq("workspace_id", workspace.id).in("id", scheduled.data.map(run => run.job_id)) : null;
  const runs = (scheduled.data ?? []).map(run => {
    const job = jobs?.data?.find(job => job.id === run.job_id);
    return { ...run, status: job?.status ?? "unknown", stage: job?.stage ?? "unavailable", error: job?.error ?? null };
  });
  let models: { id: string; name: string }[] = [], catalogueError: string | undefined;
  try { models = await listFreeModels(); } catch (error) { catalogueError = error instanceof Error ? error.message : "Model availability could not be checked"; }
  return <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
    <div><h1 className="text-3xl font-semibold tracking-tight">Settings</h1><p className="mt-2 text-muted-foreground">Your private workspace · {user.email ?? "Signed in"}</p></div>
    <SettingsForm settings={settings} currency={workspace.display_currency} models={models} catalogueError={catalogueError}
      defaultModel={process.env.OPENROUTER_MODEL ?? "qwen/qwen3.8-27b:free"} />
    <section className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">Scheduled summaries</h2>
      <p className="mt-2 text-sm text-muted-foreground">Weekly summaries become due on Monday; monthly summaries on the first day, using your timezone and preferred time. A daily check dispatches due summaries, so delivery can be delayed by a day. Each review uses the latest financial evidence. Disable summaries above to stop future runs; stop an active run below.</p>
      {!process.env.CRON_SECRET && <p className="mt-2 text-sm text-amber-700">Automatic scheduling needs to be configured on the deployment. Your preference is saved.</p>}
      {scheduled.error || jobs?.error ? <p role="alert" className="mt-3 text-sm text-red-700">Scheduled status is unavailable. Try again later.</p> : <SummaryRuns initial={runs} />}
      <p className="mt-3 text-sm text-muted-foreground">If a scheduled review fails, you can run a fresh review from AI. Completed summaries appear in Activity.</p>
    </section>
    <InsightSettings />
    <section className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">AI usage</h2><p className="mt-2 text-sm text-muted-foreground">Provider usage is shown when available in Activity. Missing token counts or costs are unknown; they are not reported as zero.</p></section>
  </main>;
}
