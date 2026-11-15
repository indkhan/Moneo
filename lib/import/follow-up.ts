import type { SupabaseClient } from "@supabase/supabase-js";
import { modelForSettings } from "@/lib/ai/provider";
import { aiConfigured } from "@/lib/ai/configured";
import { loadWorkspaceSettings, requireAiScope } from "@/lib/settings";
import { stableId } from "@/lib/import/row";
import { dispatchFinancialReview } from "@/lib/finance/start-review";
import { startAgentRun } from "@/lib/ai/agent-dispatch";

export async function startSyncAgentRun(db: SupabaseClient, workspaceId: string, importIds: string[]) {
  const landed = await db.from("imports").select("id").eq("workspace_id", workspaceId).in("id", importIds).eq("status", "completed").gt("new_rows", 0).limit(1);
  if (landed.error) throw new Error(landed.error.message);
  return landed.data.length ? startAgentRun(db, workspaceId, { trigger: "sync" }) : null;
}

export const FIRST_REVIEW_DEADLINE_MS = 24 * 3_600_000;

export async function maybeStartFirstReview(db: SupabaseClient, workspaceId: string, now = Date.now()) {
  const jobId = stableId(`${workspaceId}:first-financial-review`);
  const existing = await db.from("background_jobs").select("status").eq("id", jobId).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data && !["queued", "running"].includes(existing.data.status)) return;
  if (!existing.data) {
    const [first, pass, waiting] = await Promise.all([
      db.from("imports").select("created_at").eq("workspace_id", workspaceId).eq("status", "completed").gt("new_rows", 0).order("created_at").order("id").limit(1).maybeSingle(),
      db.from("agent_runs").select("id").eq("workspace_id", workspaceId).eq("status", "completed").limit(1).maybeSingle(),
      db.from("bank_connection_accounts").select("connection_id, bank_connections!inner(status)").eq("workspace_id", workspaceId)
        .eq("bank_connections.status", "active").is("last_booked_on", null).limit(1)]);
    for (const result of [first, pass, waiting]) if (result.error) throw result.error;
    if (!first.data) return;
    const ready = pass.data && !waiting.data?.length;
    if (!ready && now - Date.parse(first.data.created_at) < FIRST_REVIEW_DEADLINE_MS) return;
  }
  if (!(await aiConfigured())) return;
  const settings = await loadWorkspaceSettings(db, workspaceId);
  try {
    requireAiScope(settings, "accounts", "transactions");
  } catch { return; }
  await modelForSettings(settings, "imports");
  const inserted = await db.from("background_jobs").upsert({ id: jobId, workspace_id: workspaceId, kind: "financial_review" }, { onConflict: "id", ignoreDuplicates: true }).select("id").maybeSingle();
  if (inserted.error) throw inserted.error;
  await dispatchFinancialReview(db, jobId, workspaceId, false);
}
