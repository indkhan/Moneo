import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentId, Evidence, ProposalKind } from "@/lib/ai/agent-team";

export type AgentTaskView = { agent: AgentId; position: number; status: string; step: string | null; summary: string | null; events: { at: string; type: string; text: string }[]; started_at: string | null; finished_at: string | null };
export type AgentProposalView = { id: string; agent: AgentId; kind: ProposalKind; title: string; detail: string; evidence: Evidence; confidence: number; notes: string[]; status: string; result: { href?: string; undo?: string; error?: string; auto?: boolean; movedToHome?: boolean } | null };
export type AgentRunView = { id: string; status: string; trigger: string; import_id: string | null; briefing: string | null; model_calls: number; model_budget: number; model_status: string; error: string | null; created_at: string; finished_at: string | null;
  tasks: AgentTaskView[]; proposals: AgentProposalView[] };

/** One RLS-scoped read of a run with its tasks and proposals, for the page and its live polling. */
export async function loadAgentRun(db: SupabaseClient, workspaceId: string, runId: string): Promise<AgentRunView | null> {
  const [run, tasks, proposals] = await Promise.all([
    db.from("agent_runs").select("id, status, trigger, import_id, briefing, model_calls, model_budget, model_status, error, created_at, finished_at").eq("workspace_id", workspaceId).eq("id", runId).maybeSingle(),
    db.from("agent_tasks").select("agent, position, status, step, summary, events, started_at, finished_at").eq("workspace_id", workspaceId).eq("run_id", runId).order("position"),
    db.from("agent_proposals").select("id, agent, kind, title, detail, evidence, confidence, notes, status, result").eq("workspace_id", workspaceId).eq("run_id", runId).order("created_at").limit(500),
  ]);
  for (const result of [run, tasks, proposals]) if (result.error) throw new Error(result.error.message);
  if (!run.data) return null;
  return { ...run.data, tasks: tasks.data ?? [], proposals: proposals.data ?? [] } as AgentRunView;
}
