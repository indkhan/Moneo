import type {SupabaseClient} from "@supabase/supabase-js";
import {loadWorkspaceSettings, requireAiScope, type AiDataScope} from "@/lib/settings";
import {investigate} from "./investigation";
import {loadInvestigationDataset} from "./investigation-reader";
import {investigationReceipt} from "./investigation-receipt";
import {persistEvidenceReceipt} from "./evidence-receipts";
import {runReviewInvestigation, type ReviewProgress} from "./review-controller";
import type {ReviewRequest} from "./review-request";

export async function gatherReviewInvestigation(request: ReviewRequest, dependencies: {
  workspaceId: string; client: (signal?: AbortSignal) => SupabaseClient;
  checkpoint: (progress: ReviewProgress) => Promise<void>; signal?: AbortSignal;
}, previous?: ReviewProgress) {
  return runReviewInvestigation(request, {signal: dependencies.signal, checkpoint: dependencies.checkpoint,
    read: async (query, signal) => {
      const db = dependencies.client(signal);
      const settings = await loadWorkspaceSettings(db, dependencies.workspaceId);
      const allowedScopes = request.allowedScopes ?? settings.ai_data_scopes;
      requireAiScope({...settings, ai_data_scopes: allowedScopes}, "accounts", "transactions");
      const scopes: AiDataScope[] = ["accounts", "transactions", ...(allowedScopes.includes("imports") ? ["imports" as const] : [])];
      requireAiScope(settings, ...scopes);
      const dataset = await loadInvestigationDataset(query, {supabase: db, workspace: {id: dependencies.workspaceId}}, {canReadImports: scopes.includes("imports")});
      signal.throwIfAborted();
      // The scopes actually read remain required even if access changed during transport.
      requireAiScope(await loadWorkspaceSettings(db, dependencies.workspaceId), ...scopes);
      const receipt = await persistEvidenceReceipt(db, investigationReceipt(dataset, scopes));
      signal.throwIfAborted();
      return {result: investigate(dataset.spec, dataset.rows, dataset.context), receiptId: receipt.id};
    },
  }, previous);
}
