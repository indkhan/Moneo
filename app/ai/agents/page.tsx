import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { TeamFlow } from "@/components/team-flow";
import { StartAgentRun } from "./start-run";

export default async function AgentRunsPage({ searchParams }: { searchParams: Promise<{ import?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const importId = z.uuid().safeParse((await searchParams).import);
  if (importId.success) {
    const run = await supabase.from("agent_runs").select("id").eq("workspace_id", workspace.id).eq("import_id", importId.data).maybeSingle();
    if (run.data) redirect(`/ai/agents/${run.data.id}`);
  }
  const runs = await supabase.from("agent_runs").select("id, status, trigger, created_at, briefing").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(20);
  const counts = await supabase.from("agent_proposals").select("run_id, status").eq("workspace_id", workspace.id).eq("status", "proposed").limit(1000);
  const open = new Map<string, number>();
  for (const row of counts.data ?? []) open.set(row.run_id, (open.get(row.run_id) ?? 0) + 1);
  return <main className="mx-auto w-full max-w-[1400px] space-y-6 px-4 py-6 sm:px-8 lg:py-8">
    <header className="flex flex-wrap items-end gap-4">
      <div className="mr-auto flex flex-col gap-1"><p className="eyebrow">Runs after every import · {runs.data?.length ?? 0} recent {runs.data?.length === 1 ? "run" : "runs"}</p><h1 className="page-title">Agent team</h1>
        <p className="mt-1 text-sm text-muted-foreground">Specialised agents analyse your data after every import. They only propose; you decide.</p></div>
      <StartAgentRun />
    </header>
    {importId.success && <p role="status" className="rounded-lg bg-muted p-3 text-sm">The team starts as soon as that import&apos;s rows are in. <Link href={`/ai/agents?import=${importId.data}`} className="underline">Check again</Link></p>}
    <TeamFlow />
    <section aria-label="Runs" className="space-y-2">
      <h2 className="font-display text-2xl font-semibold tracking-tight">Run history</h2>
      {runs.error && <p role="alert">Could not load runs: {runs.error.message}</p>}
      {!runs.data?.length && <p className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">No runs yet. <Link href="/import" className="underline">Import a statement</Link> or start one above.</p>}
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">{(runs.data ?? []).map(run => <li key={run.id}><Link href={`/ai/agents/${run.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3.5 hover:bg-muted">
        <span className="w-44 shrink-0 text-[13px]">{new Date(run.created_at).toLocaleString(workspace.locale)}</span>
        <span className="font-mono text-xs capitalize text-muted-foreground">{run.status} · {run.trigger}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{run.briefing?.split("\n")[0]}</span>
        {open.get(run.id) ? <span className="ai-chip">{open.get(run.id)} to review</span> : null}
      </Link></li>)}</ul>
    </section>
  </main>;
}

