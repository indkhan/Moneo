import type { SupabaseClient } from "@supabase/supabase-js";
import { modelForSettings } from "@/lib/ai/provider";
import { aiConfigured } from "@/lib/ai/configured";
import { loadWorkspaceSettings, requireAiScope } from "@/lib/settings";
import { stableId } from "@/lib/import/row";
import { dispatchFinancialReview } from "@/lib/finance/start-review";
import { startAgentRun } from "@/lib/ai/agent-dispatch";

// What follows once new rows are in. A bank sync calls these once for all its accounts,
// so the agent team and the first review see the whole sync rather than one account.

/** One agent-team run for everything a bank sync added; a run already going is reused. */
export async function startSyncAgentRun(db: SupabaseClient, workspaceId: string, importIds: string[]) {
  const landed = await db.from("imports").select("id").eq("workspace_id", workspaceId).in("id", importIds).eq("status", "completed").gt("new_rows", 0).limit(1);
  if (landed.error) throw new Error(landed.error.message);
  return landed.data.length ? startAgentRun(db, workspaceId, { trigger: "sync" }) : null;
}

/** The first financial review, once per workspace, when one of these imports is the first to add rows. */
export async function maybeStartFirstReview(db: SupabaseClient, workspaceId: string, importIds: string[]) {
  if (!(await aiConfigured())) return;
  const settings = await loadWorkspaceSettings(db, workspaceId);
  try {
    requireAiScope(settings, "accounts", "transactions");
  } catch { return; } // Analysis eligibility is optional; the completed import remains valid.
  await modelForSettings(settings, "imports");
  const first = await db.from("imports").select("id").eq("workspace_id", workspaceId).eq("status", "completed").gt("new_rows", 0).order("created_at").order("id").limit(1).maybeSingle();
  if (first.error) throw first.error;
  if (!first.data || !importIds.includes(first.data.id)) return;
  const jobId = stableId(`${workspaceId}:first-financial-review`);
  const inserted = await db.from("background_jobs").upsert({ id: jobId, workspace_id: workspaceId, kind: "financial_review" }, { onConflict: "id", ignoreDuplicates: true }).select("id").maybeSingle();
  if (inserted.error) throw inserted.error;
  await dispatchFinancialReview(db, jobId, workspaceId, false);
}
