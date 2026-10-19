import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Bot } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import { AGENTS, WAVES, type AgentId } from "@/lib/ai/agent-team";
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
  return <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-8 lg:py-8">
    <header className="flex flex-wrap items-center gap-3">
      <div className="mr-auto"><h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><Bot className="size-6 text-brand" aria-hidden="true" />Agent team</h1>
        <p className="text-sm text-muted-foreground">Specialised agents analyse your data after every import. They only propose; you decide.</p></div>
      <StartAgentRun />
    </header>
    {importId.success && <p role="status" className="rounded-lg bg-muted p-3 text-sm">The team starts as soon as that import&apos;s rows are in. <Link href={`/ai/agents?import=${importId.data}`} className="underline">Check again</Link></p>}
    <TeamFlow />
    <section aria-label="Runs" className="space-y-2">
      <h2 className="text-base font-semibold">Runs</h2>
      {runs.error && <p role="alert">Could not load runs: {runs.error.message}</p>}
      {!runs.data?.length && <p className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">No runs yet. <Link href="/import" className="underline">Import a statement</Link> or start one above.</p>}
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">{(runs.data ?? []).map(run => <li key={run.id}><Link href={`/ai/agents/${run.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-muted">
        <span className="w-40 shrink-0 text-sm">{new Date(run.created_at).toLocaleString(workspace.locale)}</span>
        <span className="text-xs capitalize text-muted-foreground">{run.status} · {run.trigger}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{run.briefing?.split("\n")[0]}</span>
        {open.get(run.id) ? <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">{open.get(run.id)} to review</span> : null}
      </Link></li>)}</ul>
    </section>
  </main>;
}

const Node = ({ agent, lead }: { agent: AgentId; lead?: boolean }) => <div className={`w-full max-w-60 rounded-xl border bg-card p-3 text-center shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${lead ? "border-brand/50 ring-1 ring-brand/20" : "border-border"}`}>
  <p className="text-sm font-semibold">{AGENTS[agent].name}</p><p className="text-xs text-muted-foreground">{AGENTS[agent].role}</p></div>;

// Animated connector: a line with a pulse dot travelling down it.
const Arrow = ({ label }: { label?: string }) => <div className="flex flex-col items-center py-1" aria-hidden="true">
  <div className="relative h-8 w-px bg-gradient-to-b from-brand/60 to-border"><span className="absolute left-1/2 top-0 size-2 -translate-x-1/2 animate-ping rounded-full bg-brand" /></div>
  {label && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{label}</span>}
  <div className="size-0 border-x-4 border-t-[6px] border-x-transparent border-t-brand/60" /></div>;

const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => <li className="flex flex-col items-center gap-2">
  <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"><span className="flex size-5 items-center justify-center rounded-full bg-brand text-[11px] text-white">{n}</span>{title}</span>
  {children}</li>;

function TeamFlow() {
  return <section aria-label="How a run works" className="rounded-2xl border border-border bg-gradient-to-b from-brand/5 to-transparent p-4 sm:p-6">
    <h2 className="mb-4 text-center text-base font-semibold">How a run works</h2>
    <ol className="flex flex-col items-center">
      <Step n={1} title="Plan"><Node agent="lead" lead /></Step>
      {WAVES.map((wave, i) => <div key={i} className="contents"><li aria-hidden="true"><Arrow label={i === 0 ? "assigns work" : "then"} /></li>
        <Step n={i + 2} title={wave.length > 1 ? `Wave ${i + 1} · in parallel` : `Wave ${i + 1}`}>
          {i === WAVES.length - 1 && <><Node agent="lead" lead /><Arrow label="merges & resolves conflicts" /></>}
          <div className={`grid w-full gap-2 rounded-xl border border-dashed border-brand/30 p-2 sm:grid-cols-2 ${wave.length > 2 ? "lg:grid-cols-4" : ""}`}>{wave.map(agent => <div key={agent} className="flex justify-center"><Node agent={agent} /></div>)}</div>
        </Step></div>)}
      <li aria-hidden="true"><Arrow label="proposals + briefing" /></li>
      <Step n={WAVES.length + 2} title="You decide"><div className="rounded-xl border border-brand bg-brand/10 px-4 py-3 text-center text-sm font-medium text-brand">Review each proposal: accept or dismiss</div></Step>
    </ol>
    <p className="mt-3 text-center text-xs text-muted-foreground">Agents with nothing to do are skipped. Nothing changes until you accept.</p>
  </section>;
}
