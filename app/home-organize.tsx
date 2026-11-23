import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { displayFormat } from "@/lib/display-format";
import { organizeRunState } from "@/lib/organize/status";

export const loadLatestAgentRun = cache(async (db: SupabaseClient, workspaceId: string) =>
  db.from("agent_runs").select("id, status, created_at, finished_at, rerun_trigger, organize_after").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(1).maybeSingle());

export async function HomeOrganize({ db, workspace }: { db: SupabaseClient; workspace: { id: string; locale: string; timezone: string } }) {
  const run = await loadLatestAgentRun(db, workspace.id)
    .then(result => result.data as { status: string; rerun_trigger: string | null; organize_after: string | null } | null, () => null);
  const state = organizeRunState(run, new Date());
  if (!state.working && !state.pausedUntil) return null;
  return <p role="status" aria-label="Organizer" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-ai-border bg-ai-soft px-4 py-3 text-sm">
    {state.working && <span className="text-muted-foreground">Organizing your latest rows now{state.queued ? "; another pass is queued" : ""}.</span>}
    {state.pausedUntil && <span className="text-muted-foreground">Organizing is paused until {displayFormat(workspace.locale, workspace.timezone).dateTime(state.pausedUntil)}: the AI plan limit was reached, and rows left blank are retried then.</span>}
  </p>;
}
