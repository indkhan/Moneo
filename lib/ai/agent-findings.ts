import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Recent agent-team runs and their proposals, so chat can report and act on them by id. */
export async function agentFindings(supabase: SupabaseClient, workspaceId: string, { includeDecided = false } = {}) {
  const runs = await supabase.from("agent_runs").select("id, status, trigger, created_at, briefing").eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false }).limit(5);
  if (runs.error) throw new Error(runs.error.message);
  const ids = (runs.data ?? []).map(run => run.id as string);
  if (!ids.length) return { runs: [], findings: [] };
  const statuses = includeDecided ? ["proposed", "failed", "accepted", "rejected"] : ["proposed", "failed"];
  const proposals = await supabase.from("agent_proposals").select("id, run_id, agent, kind, title, detail, confidence, status").eq("workspace_id", workspaceId)
    .in("run_id", ids).in("status", statuses).order("created_at").limit(100);
  if (proposals.error) throw new Error(proposals.error.message);
  return {
    runs: (runs.data ?? []).map(run => ({ ...run, briefing: run.briefing?.slice(0, 1500) ?? null, href: `/ai/agents/${run.id}` })),
    findings: proposals.data ?? [],
  };
}

export const agentDecisionSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(100).describe("Proposal ids from agents_findings"),
  decision: z.enum(["accept", "reject"]).describe("accept also covers 'mark as seen/watched/acknowledged'; reject dismisses"),
}).strict();

/** Keeps only open agent-team proposals the workspace owns; the card is drawn from these ids. */
export async function openAgentProposalIds(supabase: SupabaseClient, workspaceId: string, ids: string[]) {
  const { data, error } = await supabase.from("agent_proposals").select("id").eq("workspace_id", workspaceId).in("id", ids)
    .not("run_id", "is", null).in("status", ["proposed", "failed"]);
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => row.id as string);
}

/** A decision card block in the answer; nothing changes until the user confirms on the card. */
export const decisionBlock = (ids: string[], decision: "accept" | "reject") => "```moneo-decision\n" + JSON.stringify({ ids, decision }) + "\n```";
