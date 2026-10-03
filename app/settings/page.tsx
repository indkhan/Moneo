import Link from "next/link";
import { BUILTIN_WIDGETS, dashboardItems, dashboardLayoutSchema } from "@/lib/dashboard";
import { saveDashboard } from "../dashboard-actions";
import { InsightSettings } from "./insights";
import { requireWorkspace } from "@/lib/auth";
import { listFreeModels } from "@/lib/ai/provider";
import { SettingsForm } from "./form";
import { SummaryRuns } from "./summary-runs";

export default async function SettingsPage() {
  const { user, workspace, settings, supabase } = await requireWorkspace();
  const [layout, pins] = await Promise.all([
    supabase.from("dashboard_layouts").select("items, version").eq("workspace_id", workspace.id).maybeSingle(),
    supabase.from("dashboard_items").select("artifact_id, position").eq("workspace_id", workspace.id).order("position"),
  ]);
  for (const error of [layout.error, pins.error]) if (error) throw error;
  const artifacts = pins.data?.length ? await supabase.from("artifacts")
    .select("id, name").eq("workspace_id", workspace.id).in("id", pins.data.map(pin => pin.artifact_id))
    : { data: [], error: null };
  if (artifacts.error) throw artifacts.error;
  const pinnedById = new Map(artifacts.data?.map(artifact => [artifact.id, artifact]));
  const parsedLayout = layout.data ? dashboardLayoutSchema.safeParse(layout.data.items) : null;
  const ordered = dashboardItems(parsedLayout?.success ? parsedLayout.data : null, (pins.data ?? []).map(pin => pin.artifact_id));
  const choices = [...new Set([...ordered, ...Object.keys(BUILTIN_WIDGETS)])];
  const scheduled = await supabase.from("summary_runs").select("id,job_id,cadence,period_start").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(5);
  const jobs = scheduled.data?.length ? await supabase.from("background_jobs").select("id,status,stage,error").eq("workspace_id", workspace.id).in("id", scheduled.data.map(run => run.job_id)) : null;
  const runs = (scheduled.data ?? []).map(run => {
    const job = jobs?.data?.find(job => job.id === run.job_id);
    return { ...run, status: job?.status ?? "unknown", stage: job?.stage ?? "unavailable", error: job?.error ?? null };
  });
  let models: { id: string; name: string }[] = [], catalogueError: string | undefined;
  try { models = await listFreeModels(); } catch (error) { catalogueError = error instanceof Error ? error.message : "Model availability could not be checked"; }
  return <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
    <div><h1 className="text-3xl font-semibold tracking-tight">Settings</h1><p className="mt-2 break-words text-muted-foreground">Your private workspace · {user.email ?? "Signed in"}</p></div>
    <SettingsForm settings={settings} currency={workspace.display_currency} models={models} catalogueError={catalogueError}
      defaultModel={process.env.OPENROUTER_MODEL ?? "qwen/qwen3.8-27b:free"} />
    <details className="rounded-xl border border-border bg-card p-4"><summary className="cursor-pointer font-medium">Customize Home</summary><form action={saveDashboard} className="mt-4 space-y-3"><input type="hidden" name="version" value={layout.data?.version ?? 0} />{choices.map((key, index) => <div key={key} className="flex flex-wrap items-center gap-3"><label className="flex flex-1 items-center gap-2 text-sm"><input type="checkbox" name="enabled" value={key} defaultChecked={ordered.includes(key)} disabled={key.startsWith("tool:")} />{key.startsWith("tool:") && <input type="hidden" name="enabled" value={key} />}{Object.hasOwn(BUILTIN_WIDGETS, key) ? BUILTIN_WIDGETS[key as keyof typeof BUILTIN_WIDGETS] : pinnedById.get(key.slice(5))?.name}</label><label className="flex items-center gap-2 text-xs">Position<input type="number" name={`position:${key}`} min="1" max="50" defaultValue={ordered.includes(key) ? ordered.indexOf(key) + 1 : index + 1} className="w-16 rounded border border-border bg-background p-2" /></label></div>)}<button className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">Save dashboard</button><p className="text-xs text-muted-foreground">Pin or unpin tools in the <Link href="/ai/library" className="underline">Library</Link>. Lower positions appear first.</p></form></details>
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
