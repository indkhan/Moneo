import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Bot, LoaderCircle } from "lucide-react";
import { StartAgentRun } from "./ai/agents/start-run";

/** Home's proactive briefing: the latest agent-team run, what it found and what waits for review. */
export async function AgentBriefing({ db, workspaceId }: { db: SupabaseClient; workspaceId: string }) {
  const latest = await db.from("agent_runs").select("id, status, briefing, created_at").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (latest.error) return null;
  const run = latest.data;
  const open = run ? await db.from("agent_proposals").select("kind").eq("workspace_id", workspaceId).eq("run_id", run.id).eq("status", "proposed").limit(500) : null;
  const findings = open?.data?.filter(item => item.kind === "finding").length ?? 0, changes = (open?.data?.length ?? 0) - findings;
  const running = run && ["queued", "running"].includes(run.status);
  return <section aria-label="Agent briefing" className="flex flex-wrap items-start gap-4 rounded-xl border border-brand/30 bg-card p-4">
    <Bot className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <h2 className="text-sm font-semibold">{running ? "Your agent team is working" : run?.briefing ? "Briefing from your agent team" : "Agent team"}</h2>
      {running ? <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />Analysing your latest data. <Link href={`/ai/agents/${run.id}`} className="text-brand underline">Watch live</Link></p>
        : run?.briefing ? <p className="mt-1 line-clamp-3 text-sm">{run.briefing.split(/\n{2,}/)[0]}</p>
        : <p className="mt-1 text-sm text-muted-foreground">Seven specialised agents categorize, find subscriptions and anomalies, forecast cash and propose limits. They run after every import, or now.</p>}
      {run && !running && (findings > 0 || changes > 0) && <p className="mt-2 text-xs"><Link href={`/ai/agents/${run.id}`} className="font-medium text-brand underline">{[changes && `${changes} changes to review`, findings && `${findings} findings`].filter(Boolean).join(" · ")}</Link></p>}
    </div>
    {!running && <StartAgentRun label={run ? "Run again" : "Run agent team"} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50" />}
  </section>;
}
