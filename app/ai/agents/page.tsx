import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { AutoRefresh } from "@/components/auto-refresh";
import { PhoneCollapse } from "@/components/phone-collapse";
import { TeamFlow } from "@/components/team-flow";
import { StartAgentRun } from "./start-run";
import { IouReview } from "@/app/iou-review";

export const metadata = { title: "Agent team" };

const PAGE = 20;
const STATUS: Record<string, string> = { queued: "Queued", running: "Running", completed: "Finished", failed: "Failed", canceled: "Stopped" };

export default async function AgentRunsPage({ searchParams }: { searchParams: Promise<{ import?: string; before?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/setup"); }
  const { supabase, workspace } = context;
  const query = await searchParams;
  const importId = z.uuid().safeParse(query.import);
  const before = z.iso.datetime({ offset: true }).safeParse(query.before);
  if (importId.success) {
    const run = await supabase.from("agent_runs").select("id").eq("workspace_id", workspace.id).eq("import_id", importId.data).maybeSingle();
    if (run.data) redirect(`/ai/agents/${run.data.id}`);
  }
  const importRow = importId.success ? await supabase.from("imports").select("status").eq("workspace_id", workspace.id).eq("id", importId.data).maybeSingle() : null;
  const history = supabase.from("agent_runs").select("id, status, trigger, created_at, briefing").eq("workspace_id", workspace.id);
  const [runs, counts] = await Promise.all([
    (before.success ? history.lt("created_at", before.data) : history).order("created_at", { ascending: false }).limit(PAGE + 1),
    supabase.from("agent_proposals").select("run_id, kind").eq("workspace_id", workspace.id).eq("status", "proposed").not("run_id", "is", null).limit(1000),
  ]);
  const limits = new Map<string, number>(), onHome = new Map<string, number>();
  for (const row of counts.data ?? []) { const tally = row.kind === "budget" ? limits : onHome; tally.set(row.run_id, (tally.get(row.run_id) ?? 0) + 1); }
  const page = (runs.data ?? []).slice(0, PAGE);
  const when = new Intl.DateTimeFormat(workspace.locale, { dateStyle: "medium", timeStyle: "short", timeZone: workspace.timezone });
  const activeRun = !before.success ? page.find(run => run.status === "queued" || run.status === "running") : undefined;
  return <main className="mx-auto w-full max-w-[1400px] space-y-6 px-4 py-6 sm:px-8 lg:py-8">
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="flex flex-1 flex-col gap-1"><p className="eyebrow">Runs after every import</p><h1 className="page-title">Agent team</h1>
        <p className="mt-1 text-sm text-muted-foreground">After every sync the team checks your data: it categorizes what it is sure of, and leaves the rest, recurring payments and anything odd on Home for you. This is the record of each run.</p></div>
      <div className="flex max-w-xs shrink-0 flex-col gap-1 sm:items-end sm:text-right">
        {activeRun ? <Link href={`/ai/agents/${activeRun.id}`} className="inline-flex h-11 items-center rounded-xl bg-ai px-4 text-[13px] font-medium text-[#0f1011] hover:opacity-90">View running review</Link> : <StartAgentRun label="Review current data" />}
        <p className="text-xs text-muted-foreground">Checks your accounts and transactions. Most checks are rules; it may use a few AI calls, shown on the run.</p>
      </div>
    </header>
    <PhoneCollapse label="How reviews work"><TeamFlow /></PhoneCollapse>
    {importId.success && (importRow?.data?.status === "failed"
      ? <p role="alert" className="rounded-lg bg-muted p-3 text-sm">That import failed, so no review started. <Link href="/import" className="underline">Open imports</Link></p>
      : <p role="status" className="rounded-lg bg-muted p-3 text-sm">The team starts as soon as that import&apos;s rows are in; this page moves to it by itself. <Link href="/import" className="underline">Open imports</Link><AutoRefresh /></p>)}
    <IouReview db={supabase} workspaceId={workspace.id} />
    <section aria-label="Runs" className="space-y-2">
      <h2 className="font-display text-2xl font-semibold tracking-tight">Run history</h2>
      {page.length > 0 && <p className="text-xs text-muted-foreground">{before.success ? "Older reviews" : `Latest ${page.length} ${page.length === 1 ? "review" : "reviews"}`}</p>}
      {counts.error && !runs.error && <p className="text-xs text-muted-foreground">Open decision counts are unavailable right now.</p>}
      {runs.error ? <p role="alert" className="text-sm">Could not load your runs. <Link href="/ai/agents" className="underline">Try again</Link></p>
        : !page.length ? <p className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">No runs yet. <Link href="/import" className="underline">Import a statement</Link> or start one above.</p>
        : <ul className="divide-y divide-border rounded-xl border border-border bg-card">{page.map(run => <li key={run.id}><Link href={`/ai/agents/${run.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3.5 hover:bg-muted">
        <span className="text-[13px] font-medium">{STATUS[run.status] ?? run.status}</span>
        <span className="text-[13px] text-muted-foreground">{when.format(new Date(run.created_at))} · {run.trigger === "import" ? "after an import" : "started by you"}</span>
        {limits.get(run.id) ? <span className="ai-chip">{limits.get(run.id)} limits to review</span> : null}
        {onHome.get(run.id) ? <span className="ai-chip">{onHome.get(run.id)} waiting on Home</span> : null}
        <span className="ml-auto text-xs underline">View review</span>
        {run.briefing && <span className="line-clamp-2 basis-full text-sm text-muted-foreground">{run.briefing.split("\n")[0]}</span>}
      </Link></li>)}</ul>}
      {(runs.data?.length ?? 0) > PAGE && <Link href={`/ai/agents?${new URLSearchParams({ before: page.at(-1)!.created_at })}`} className="inline-block min-h-11 py-3 text-sm underline">Older reviews</Link>}
      {before.success && <Link href="/ai/agents" className="ml-4 inline-block min-h-11 py-3 text-sm underline">Latest reviews</Link>}
    </section>
  </main>;
}

