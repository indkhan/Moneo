import type { SupabaseClient } from "@supabase/supabase-js";
import { getRun, start } from "workflow/api";
import { agentTeam } from "@/workflows/agent-team";
import { loadWorkspaceSettings } from "@/lib/settings";
import { backlogRerunNeeded } from "@/lib/ai/agent-team";

async function activeRunId(db: SupabaseClient, workspaceId: string) {
  const active = await db.from("agent_runs").select("id").eq("workspace_id", workspaceId).in("status", ["queued", "running"]).limit(1).maybeSingle();
  if (active.error) throw active.error;
  return (active.data?.id as string | undefined) ?? null;
}

/**
 * Creates the run for an import, a bank sync, the backlog check or a manual request and starts the
 * durable team. A workspace has at most one queued or running run (agent_runs_one_active), and every
 * start reuses it: the categorizer reads all unorganized rows, and rows that arrive after a run
 * started get the next one from the backlog check.
 */
export async function startAgentRun(db: SupabaseClient, workspaceId: string, options: { importId?: string; trigger?: "sync" | "backlog" } = {}) {
  if (options.importId) {
    const existing = await db.from("agent_runs").select("id").eq("workspace_id", workspaceId).eq("import_id", options.importId).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) return existing.data.id as string;
  }
  const active = await activeRunId(db, workspaceId);
  if (active) return active;
  // Automatic runs respect the owner's AI data access; a manual start plans around it instead.
  if ((options.importId || options.trigger) && !(await loadWorkspaceSettings(db, workspaceId)).ai_data_scopes.includes("transactions")) return null;
  const inserted = await db.from("agent_runs").insert({ workspace_id: workspaceId, import_id: options.importId ?? null, trigger: options.importId ? "import" : options.trigger ?? "manual" }).select("id").single();
  if (inserted.error) {
    if (inserted.error.code !== "23505") throw inserted.error;
    // Another start won the race: this import's own run, or the workspace's active run.
    const raced = options.importId ? await db.from("agent_runs").select("id").eq("workspace_id", workspaceId).eq("import_id", options.importId).maybeSingle() : null;
    if (raced?.error) throw raced.error;
    const id = (raced?.data?.id as string | undefined) ?? await activeRunId(db, workspaceId);
    if (!id) throw inserted.error;
    return id;
  }
  await dispatch(db, inserted.data.id, workspaceId);
  return inserted.data.id as string;
}

/** The hourly check: a run for rows still lacking a merchant or category, when backlogRerunNeeded says so. */
export async function startBacklogRun(db: SupabaseClient, workspaceId: string, now = Date.now()) {
  const settings = await loadWorkspaceSettings(db, workspaceId);
  const transactionsAllowed = settings.ai_data_scopes.includes("transactions");
  if (!transactionsAllowed) return null;
  const unorganized = () => db.from("transactions").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "posted").or("merchant_id.is.null,category_id.is.null");
  const [runs, backlog] = await Promise.all([db.from("agent_runs").select("status, created_at, organize_after").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(3), unorganized()]);
  if (runs.error) throw runs.error;
  if (backlog.error) throw backlog.error;
  const latest = runs.data[0] as { status: string; created_at: string; organize_after: string | null } | undefined;
  const since = latest && backlog.count ? await unorganized().gt("created_at", latest.created_at) : null;
  if (since?.error) throw since.error;
  const due = backlogRerunNeeded({ transactionsAllowed, unorganized: backlog.count ?? 0, recentRuns: runs.data.map(run => run.status as string),
    unorganizedSinceLatestRun: (since?.count ?? 0) > 0, retryAt: latest?.organize_after ?? null, now });
  return due ? startAgentRun(db, workspaceId, { trigger: "backlog" }) : null;
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
  if (reopened.error?.code === "23505") throw new Error("Another agent run is in progress; resume this one after it finishes");
  if (reopened.error) throw reopened.error;
  if (!reopened.data) return "inactive";
  const tasks = await db.from("agent_tasks").update({ status: "pending", finished_at: null }).eq("run_id", runId).eq("workspace_id", workspaceId).in("status", ["canceled", "failed", "running"]);
  if (tasks.error) throw tasks.error;
  await dispatch(db, runId, workspaceId);
  return "queued";
}
