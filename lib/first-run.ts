import type { SupabaseClient } from "@supabase/supabase-js";
import { cache } from "react";

export type FirstRunState = { ai: boolean; aiSkipped: boolean; money: boolean; transactions: boolean; agentRan: boolean };
export type AiStep = "on" | "skipped" | "todo";
export type FirstRun = { show: boolean; ai: AiStep; money: boolean; agents: { done: boolean } | null; canCustomize: boolean };

export function firstRun({ ai, aiSkipped, money, transactions, agentRan }: FirstRunState): FirstRun {
  const aiStep: AiStep = ai ? "on" : aiSkipped ? "skipped" : "todo";
  const agents = transactions && aiStep !== "skipped" ? { done: agentRan } : null;
  return { show: aiStep === "todo" || !money || (agents !== null && !agents.done), ai: aiStep, money, agents, canCustomize: money };
}

const anyRow = async (query: PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>) => {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data?.length ?? 0) > 0;
};

export const loadFirstRun = cache(async (db: SupabaseClient, workspaceId: string, ai: Promise<boolean>) => {
  const [accounts, wealth, transactions, agentRan, skipped, aiOn] = await Promise.all([
    anyRow(db.from("accounts").select("id").eq("workspace_id", workspaceId).is("archived_at", null).limit(1)),
    anyRow(db.from("wealth_items").select("id").eq("workspace_id", workspaceId).is("removed_at", null).limit(1)),
    anyRow(db.from("transactions").select("id").eq("workspace_id", workspaceId).limit(1)),
    anyRow(db.from("agent_runs").select("id").eq("workspace_id", workspaceId).limit(1)),
    db.from("workspace_settings").select("ai_setup_skipped_at").eq("workspace_id", workspaceId).maybeSingle(),
    ai,
  ]);
  if (skipped.error) throw new Error(skipped.error.message);
  return firstRun({ ai: aiOn, aiSkipped: Boolean(skipped.data?.ai_setup_skipped_at), money: accounts || wealth || transactions, transactions, agentRan });
});
