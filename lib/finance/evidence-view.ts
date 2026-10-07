import type { requireWorkspace } from "@/lib/auth";
import { z } from "zod";
import { requireAiScope } from "@/lib/settings";
import { loadEvidenceReceipt, evidenceFreshness } from "./evidence-receipts";
import { loadInvestigationDataset, investigationDetail, loadInvestigationEntities } from "./investigation-reader";
import { INVESTIGATION_CALCULATION_VERSION } from "./investigation-receipt";
import { TOOL_CALCULATION_VERSION, toolSourceVersion } from "./tool-evidence";
import { cashflow, getBalances, searchTransactions, listAccounts, listGoals, evaluateForecast } from "./tools";
import { loadFinancialReviewEvidence } from "./review-loader";
import { categoryPreviewSchema, loadCategoryPreview } from "./edit-preview";
import { retainToolSourceSupport } from "./tool-source-support";
import {loadReviewGoals} from "./review-planning";
export async function readEvidenceView(context: Awaited<ReturnType<typeof requireWorkspace>>, id: string, metricId?: string) {
  z.uuid().parse(id);
  const receipt = await loadEvidenceReceipt(context.supabase, context.workspace.id, id);
  if (!receipt) return null;
  if (receipt.workspaceId !== context.workspace.id) throw new Error("Evidence ownership mismatch");
  requireAiScope(context.settings, ...receipt.scopes);
  const metric = metricId ? receipt.metrics.find(item => item.id === metricId) : null;
  if (metricId && !metric) throw new Error("Metric unavailable");
  let sourceVersion: string | null = null;
  let calculationVersion = TOOL_CALCULATION_VERSION;
  try {
    if (receipt.query.kind === "investigation" || receipt.query.kind === "scenario") {
      calculationVersion = INVESTIGATION_CALCULATION_VERSION;
      const dataset = await loadInvestigationDataset(receipt.query.spec, context, { canReadImports: receipt.scopes.includes("imports"), includeAll: receipt.query.kind === "scenario" || receipt.query.includeAll === true });
      sourceVersion = dataset.sourceRevision;
    } else if (receipt.query.kind === "tool") {
      const input = receipt.query.input, imports = receipt.scopes.includes("imports");
      const query = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      let result: unknown;
      switch (receipt.query.toolName) {
        case "analytics_cashflow": result = await cashflow(input, context, imports); break;
        case "accounts_getBalances": result = await getBalances(context, imports, true); break;
        case "accounts_list": result = await listAccounts(context); break;
        case "transactions_search": result = await searchTransactions(input, context); break;
        case "goals_list": result = await listGoals(context); break;
        case "goals_review": result = await loadReviewGoals(input, context.supabase, context.workspace.id); break;
        case "forecast_evaluate": result = await evaluateForecast(input, {...context, settings: {...context.settings, ai_data_scopes: receipt.scopes}}); break;
        case "reviews_investigate": result = await loadFinancialReviewEvidence(context.supabase, context.workspace, context.settings, "query" in query ? query.query : undefined); break;
        case "finance_entities": result = await loadInvestigationEntities(context); break;
        case "finance_detail": result = await investigationDetail(input, context, { canReadImports: imports }); break;
        case "transactions_previewCategory": {
          const args = categoryPreviewSchema.parse(input);
          result = await loadCategoryPreview(context.supabase, context.workspace.id, args.transactionIds, args.categoryId); break;
        }
      }
      if (result !== undefined) sourceVersion = toolSourceVersion(await retainToolSourceSupport(String(receipt.query.toolName), input, result, context, imports));
    }
  } catch { sourceVersion = null; }
  const supportingIds = metric ? new Set(metric.sourceIds) : null;
  return { receipt, metric: metric ?? null, supportingRecords: receipt.sources.filter(source => !supportingIds || supportingIds.has(source.id)), freshness: evidenceFreshness(receipt, sourceVersion, calculationVersion) };
}
