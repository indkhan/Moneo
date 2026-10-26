import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowRight, Sparkle } from "lucide-react";
import { AGENT_IDS, AGENTS } from "@/lib/ai/agent-team";
import { StartAgentRun } from "./ai/agents/start-run";

type Task = { agent: string; status: string; summary: string | null };
const DOT: Record<string, string> = { done: "bg-brand", failed: "bg-warning", running: "animate-pulse bg-ai", pending: "bg-subtle", skipped: "bg-subtle", canceled: "bg-subtle" };
const time = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(iso));
const duration = (from: string, to: string) => { const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)); return `${Math.floor(seconds / 60)}m ${seconds % 60}s`; };

/** Home's agent team: each agent's result from the latest run, and what waits for review. */
export async function AgentBriefing({ db, workspaceId, timeZone = "UTC" }: { db: SupabaseClient; workspaceId: string; timeZone?: string }) {
  const latest = await db.from("agent_runs").select("id, status, created_at, finished_at").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (latest.error) return null;
  const run = latest.data;
  const [tasks, open] = run ? await Promise.all([
    db.from("agent_tasks").select("agent, status, summary").eq("workspace_id", workspaceId).eq("run_id", run.id),
    db.from("agent_proposals").select("kind").eq("workspace_id", workspaceId).eq("run_id", run.id).eq("status", "proposed").limit(500),
  ]) : [null, null];
  const byAgent = new Map(((tasks?.data ?? []) as Task[]).map(task => [task.agent, task]));
  const proposals = open?.data?.length ?? 0;
  const running = run && ["queued", "running"].includes(run.status);
  return <section aria-labelledby="home-agents" className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-6 sm:p-7">
    <div className="flex items-baseline justify-between gap-2">
      <h2 id="home-agents" className="flex items-center gap-2 text-sm font-medium"><Sparkle className="size-3.5 fill-current text-ai" aria-hidden="true" /><Link href={run ? `/ai/agents/${run.id}` : "/ai/agents"} className="hover:underline">Agent team</Link></h2>
      {run && <span className="font-mono text-[11px] text-subtle">{running ? "running now" : `last run ${time(run.created_at, timeZone)}${run.finished_at ? ` · ${duration(run.created_at, run.finished_at)}` : ""}`}</span>}
    </div>
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">{AGENT_IDS.map(id => { const task = byAgent.get(id); return <li key={id} className="min-w-0 rounded-lg border border-border p-3">
      <p className="flex items-center gap-1.5 text-[13px] font-medium"><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOT[task?.status ?? "pending"] ?? "bg-subtle"}`} /><span className="truncate">{AGENTS[id].name}</span></p>
      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" title={task?.summary ?? AGENTS[id].role}>{task?.summary ?? (task ? task.status : AGENTS[id].role)}</p>
    </li>; })}</ul>
    <div className="mt-auto">
      {running ? <Link href={`/ai/agents/${run.id}`} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-ai text-[13px] font-medium text-[#0f1011] hover:opacity-90">Watch live<ArrowRight className="size-4" aria-hidden="true" /></Link>
        : proposals > 0 ? <Link href={`/ai/agents/${run!.id}`} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary text-[13px] font-medium text-primary-foreground hover:opacity-90">Review {proposals} proposal{proposals === 1 ? "" : "s"}<ArrowRight className="size-4" aria-hidden="true" /></Link>
        : <StartAgentRun label={run ? "Run again" : "Run agent team"} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-input text-[13px] font-medium hover:bg-muted disabled:opacity-50" />}
    </div>
  </section>;
}
