import type { SupabaseClient } from "@supabase/supabase-js";
import { getRun, start } from "workflow/api";
import { agentTeam } from "@/workflows/agent-team";
import { loadWorkspaceSettings } from "@/lib/settings";

/** Creates (or reuses) the run for an import or a manual request and starts the durable team. */
export async function startAgentRun(db: SupabaseClient, workspaceId: string, options: { importId?: string } = {}) {
  if (options.importId) {
    const existing = await db.from("agent_runs").select("id").eq("workspace_id", workspaceId).eq("import_id", options.importId).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) return existing.data.id as string;
    const settings = await loadWorkspaceSettings(db, workspaceId);
    if (!settings.ai_data_scopes.includes("transactions")) return null; // The owner turned AI data access off.
  } else {
    const active = await db.from("agent_runs").select("id").eq("workspace_id", workspaceId).in("status", ["queued", "running"]).limit(1).maybeSingle();
    if (active.error) throw active.error;
    if (active.data) return active.data.id as string;
  }
  const inserted = await db.from("agent_runs").insert({ workspace_id: workspaceId, import_id: options.importId ?? null, trigger: options.importId ? "import" : "manual" }).select("id").single();
  if (inserted.error) {
    if (inserted.error.code !== "23505" || !options.importId) throw inserted.error;
    const raced = await db.from("agent_runs").select("id").eq("workspace_id", workspaceId).eq("import_id", options.importId).single();
    if (raced.error) throw raced.error;
    return raced.data.id as string;
  }
  await dispatch(db, inserted.data.id, workspaceId);
  return inserted.data.id as string;
}

async function dispatch(db: SupabaseClient, runId: string, workspaceId: string) {
  try { await start(agentTeam, [runId, workspaceId]); }
  catch (error) {
    await db.from("agent_runs").update({ status: "failed", error: String(error).slice(0, 2000), finished_at: new Date().toISOString() }).eq("id", runId).eq("workspace_id", workspaceId);
    throw error;
  }
}

/** Stop: fence every future step, cancel the durable run, and close open tasks. */
export async function cancelAgentRun(db: SupabaseClient, runId: string, workspaceId: string) {
  const now = new Date().toISOString();
  const run = await db.from("agent_runs").update({ cancel_requested: true, updated_at: now }).eq("id", runId).eq("workspace_id", workspaceId).in("status", ["queued", "running"])
    .select("workflow_run_id").maybeSingle();
  if (run.error) throw run.error;
  if (!run.data) return "inactive";
  if (run.data.workflow_run_id) await getRun(run.data.workflow_run_id).cancel().catch(() => undefined); // Steps are fenced by cancel_requested either way.
  const closed = await db.from("agent_runs").update({ status: "canceled", finished_at: now }).eq("id", runId).eq("workspace_id", workspaceId).in("status", ["queued", "running"]);
  if (closed.error) throw closed.error;
  const tasks = await db.from("agent_tasks").update({ status: "canceled", finished_at: now }).eq("run_id", runId).eq("workspace_id", workspaceId).in("status", ["pending", "running"]);
  if (tasks.error) throw tasks.error;
  return "canceled";
}

/** Resume a stopped or failed run: finished agents keep their results, the rest run again. */
export async function resumeAgentRun(db: SupabaseClient, runId: string, workspaceId: string) {
  const reopened = await db.from("agent_runs").update({ status: "queued", cancel_requested: false, error: null, finished_at: null, updated_at: new Date().toISOString() })
    .eq("id", runId).eq("workspace_id", workspaceId).in("status", ["canceled", "failed"]).select("id").maybeSingle();
  if (reopened.error) throw reopened.error;
  if (!reopened.data) return "inactive";
  const tasks = await db.from("agent_tasks").update({ status: "pending", finished_at: null }).eq("run_id", runId).eq("workspace_id", workspaceId).in("status", ["canceled", "failed", "running"]);
  if (tasks.error) throw tasks.error;
  await dispatch(db, runId, workspaceId);
  return "queued";
}
