import type {SupabaseClient} from "@supabase/supabase-js";
import {loadWorkspaceSettings, requireAiScope, type AiDataScope} from "@/lib/settings";
import {investigate} from "./investigation";
import {loadInvestigationDataset} from "./investigation-reader";
import {investigationReceipt} from "./investigation-receipt";
import {persistEvidenceReceipt} from "./evidence-receipts";
import {runReviewInvestigation, type ReviewProgress} from "./review-controller";
import type {ReviewRequest} from "./review-request";
import type {requireWorkspace} from "@/lib/auth";
import {evaluateForecast} from "./tools";
import {toolResultReceipt} from "./tool-evidence";
import {loadReviewGoals} from "./review-planning";

export async function gatherReviewInvestigation(request: ReviewRequest, dependencies: {
  workspaceId: string; client: (signal?: AbortSignal) => SupabaseClient;
  checkpoint: (progress: ReviewProgress) => Promise<void>; signal?: AbortSignal;
}, previous?: ReviewProgress) {
  return runReviewInvestigation(request, {signal: dependencies.signal, checkpoint: dependencies.checkpoint,
    readPlanning: async (view, supportLimit, signal) => {
      const db = dependencies.client(signal);
      const settings = await loadWorkspaceSettings(db, dependencies.workspaceId);
      const allowedScopes = request.allowedScopes ?? settings.ai_data_scopes;
      const scopes: AiDataScope[] = view.view === "goals" ? ["planning"] : ["accounts", "transactions", "planning", ...(allowedScopes.includes("imports") ? ["imports" as const] : [])];
      requireAiScope({...settings, ai_data_scopes: allowedScopes}, ...scopes);
      requireAiScope(settings, ...scopes);
      let result: unknown;
      let supportRecords: number;
      const input = view.view === "forecast" ? view.input : {goalIds: view.goalIds, limit: supportLimit};
      const toolName = view.view === "forecast" ? "forecast_evaluate" : "goals_review";
      if (view.view === "goals") {
        const goals = await loadReviewGoals(input, db, dependencies.workspaceId);
        result = goals; supportRecords = goals.goals.length;
      } else {
        const workspace = await db.from("workspaces").select("id, display_currency").eq("id", dependencies.workspaceId).single();
        if (workspace.error) throw workspace.error;
        const context = {supabase: db, workspace: {...workspace.data, timezone: settings.timezone}, settings: {...settings, ai_data_scopes: allowedScopes}} as Awaited<ReturnType<typeof requireWorkspace>>;
        result = await evaluateForecast(input, context);
        // One retained calculation record supports the bounded forecast summary; underlying inputs remain inspectable.
        supportRecords = 1;
      }
      signal.throwIfAborted();
      requireAiScope(await loadWorkspaceSettings(db, dependencies.workspaceId), ...scopes);
      const receipt = await persistEvidenceReceipt(db, toolResultReceipt(toolName, input, result,
        {workspaceId: dependencies.workspaceId, fetchedAt: new Date().toISOString(), timezone: settings.timezone}, scopes));
      signal.throwIfAborted();
      return {receiptId: receipt.id, supportRecords};
    },
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
