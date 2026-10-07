import type { SupabaseClient } from "@supabase/supabase-js";
import type { requireWorkspace } from "@/lib/auth";
import type { EvidenceReceipt } from "./evidence-receipts";
import { persistEvidenceReceipt, createEvidenceReceipt } from "./evidence-receipts";
import { requireAiScope, type AiDataScope } from "@/lib/settings";
import { toolResultReceipt } from "./tool-evidence";
import { loadInvestigationDataset, investigationScenarioSchema } from "./investigation-reader";
import { investigationReceipt } from "./investigation-receipt";
import { getBalances } from "./tools";
import { retainToolSourceSupport } from "./tool-source-support";
const scopesByTool: Record<string, AiDataScope[]> = {
  artifacts_create: [],
  accounts_list: ["accounts"], accounts_getBalances: ["accounts"], analytics_cashflow: ["transactions"], transactions_search: ["transactions"], goals_list: ["planning"],
  forecast_evaluate: ["accounts", "transactions", "planning"], finance_investigate: ["accounts", "transactions"], finance_entities: ["accounts", "transactions"], finance_detail: ["accounts", "transactions"], finance_scenario: ["accounts", "transactions"],
  reviews_investigate: ["accounts", "transactions"], reviews_start: ["accounts", "transactions"], imports_status: ["imports"], transactions_previewCategory: ["transactions"], transactions_setCategory: ["transactions"],
};
export async function captureToolEvidence(name: string, input: unknown, result: unknown, context: Awaited<ReturnType<typeof requireWorkspace>>, service: SupabaseClient, actualReadScopes?: AiDataScope[]): Promise<EvidenceReceipt[]> {
  const scopes = [...(scopesByTool[name] ?? ["accounts", "transactions"])];
  if (actualReadScopes) scopes.push(...actualReadScopes);
  else {
    if (["accounts_getBalances", "analytics_cashflow", "forecast_evaluate", "finance_investigate", "finance_detail", "finance_scenario", "reviews_investigate"].includes(name) && context.settings.ai_data_scopes.includes("imports")) scopes.push("imports");
    if (name === "reviews_investigate" && context.settings.ai_data_scopes.includes("planning")) scopes.push("planning");
  }
  if (name === "finance_detail" && input && typeof input === "object" && "kind" in input && input.kind === "recurring") scopes.push("planning");
  const unique = [...new Set(scopes)];
  requireAiScope(context.settings, ...unique);
  const receipts: EvidenceReceipt[] = [];
  if (name === "finance_investigate") {
    receipts.push(investigationReceipt(await loadInvestigationDataset(input, context, { canReadImports: unique.includes("imports") }), unique));
  } else if (name === "finance_scenario") {
    const args = investigationScenarioSchema.parse(input);
    const dataset = await loadInvestigationDataset(args.query, context, { canReadImports: unique.includes("imports"), includeAll: true });
    const baseline = investigationReceipt(dataset, unique);
    receipts.push(createEvidenceReceipt({ workspaceId: baseline.workspaceId, fetchedAt: baseline.fetchedAt, scopes: baseline.scopes, calculationVersion: baseline.calculationVersion, sourceVersion: baseline.sourceVersion,
      query: { ...baseline.query, includeAll: true }, sources: baseline.sources.map(source => ({ id: source.id, type: source.type, entityId: source.entityId, version: source.version, record: source.record })), metrics: baseline.metrics, limitations: baseline.limitations }));
    const hypothetical = investigationReceipt({ ...dataset, rows: dataset.rows.map(row => ({ ...row, ...args.overrides.find(override => override.id === row.id) })) }, unique);
    receipts.push(createEvidenceReceipt({ workspaceId: hypothetical.workspaceId, fetchedAt: hypothetical.fetchedAt, scopes: hypothetical.scopes, calculationVersion: hypothetical.calculationVersion, sourceVersion: hypothetical.sourceVersion,
      query: { ...hypothetical.query, kind: "scenario", overrides: args.overrides },
      sources: hypothetical.sources.map(source => ({ id: source.id, type: source.type, entityId: source.entityId, version: source.version, record: source.record })), metrics: hypothetical.metrics.map(metric => ({ ...metric, label: `Hypothetical ${metric.label}`, qualifiers: [...new Set([...metric.qualifiers, "assumption"])] })), limitations: hypothetical.limitations }));
  } else {
    const supported = name === "accounts_getBalances" ? await getBalances(context, unique.includes("imports"), true) : await retainToolSourceSupport(name, input, result, context, unique.includes("imports"));
    receipts.push(toolResultReceipt(name, input, supported, { workspaceId: context.workspace.id, fetchedAt: new Date().toISOString(), timezone: context.workspace.timezone }, unique));
    if (name === "reviews_investigate" && result && typeof result === "object" && "queryInvestigation" in result) {
      const query = result.queryInvestigation;
      if (query && typeof query === "object" && "interpretedFilters" in query) receipts.push(investigationReceipt(await loadInvestigationDataset(query.interpretedFilters, context, { canReadImports: unique.includes("imports") }), unique));
    }
  }
  const saved: EvidenceReceipt[] = [];
  for (const receipt of receipts) saved.push(await persistEvidenceReceipt(service, receipt));
  return saved;
}
