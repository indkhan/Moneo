import type { AiDataScope } from "@/lib/settings";
import type { EvidenceReceipt } from "./evidence-receipts";
import { createEvidenceReceipt, evidenceFingerprint, type EvidenceReceiptInput } from "./evidence-receipts";
import { investigate, type InvestigationSpec, type InvestigationRow, type InvestigationContext } from "./investigation";
export const INVESTIGATION_CALCULATION_VERSION = "investigation-v1-canonical-fx-allocation";
export function investigationReceipt(dataset: { spec: InvestigationSpec; rows: InvestigationRow[]; context: InvestigationContext; sourceRevision: string }, scopes: AiDataScope[]): EvidenceReceipt {
  const spec = { ...dataset.spec, page: { size: 25, period: "both" as const } };
  const result = investigate(spec, dataset.rows, dataset.context, { retainSupport: true });
  const records = result.retainedRecords ?? [];
  const qualifiers: EvidenceReceiptInput["metrics"][number]["qualifiers"] = ["partial_coverage"];
  if (result.coverage.classificationExcluded) qualifiers.push("partial_classification");
  if (result.coverage.unresolvedIncluded) qualifiers.push("unresolved_included");
  const metrics: EvidenceReceiptInput["metrics"] = result.groups.flatMap(group => {
    const key = evidenceFingerprint(group.key).slice(0, 32);
    const support = records.filter(row => row.groupKey === group.key);
    const common = { currency: group.currency, qualifiers, calculation: `${spec.metric}: ${JSON.stringify(spec)}. Effective allocations are counted once. ${result.reporting ? `${result.reporting.policy}; ${result.reporting.allocationPolicy}.` : "Original-currency exact minor units."}` };
    return [{ ...common, id: `${key}:current`, label: `${spec.metric} ${JSON.stringify(group.dimensions)}`, valueMinor: group.currentMinor, period: spec.period, sourceIds: support.filter(row => row.current).map(row => row.id) },
      ...(spec.comparison ? [{ ...common, id: `${key}:comparison`, label: `${spec.metric} ${JSON.stringify(group.dimensions)}`, valueMinor: group.comparisonMinor, period: spec.comparison, sourceIds: support.filter(row => row.comparison).map(row => row.id) },
        { ...common, id: `${key}:delta`, label: `${spec.metric} change: ${spec.period.from} to ${spec.period.to} compared with ${spec.comparison.from} to ${spec.comparison.to} ${JSON.stringify(group.dimensions)}`, valueMinor: group.deltaMinor, period: spec.period, sourceIds: support.map(row => row.id) }] : [])];
  });
  return createEvidenceReceipt({ workspaceId: dataset.context.workspaceId, fetchedAt: dataset.context.capturedAt, calculationVersion: INVESTIGATION_CALCULATION_VERSION, sourceVersion: dataset.sourceRevision,
    scopes, query: JSON.parse(JSON.stringify({ kind: "investigation", spec, sourceCoverage: result.coverage.sourceCoverage, reporting: result.reporting })),
    sources: records.map(row => ({ id: row.id, entityId: row.parentId, type: "transaction", version: evidenceFingerprint({ version: row.version, sources: row.sourceVersions, amount: row.amountMinor, reportingAmount: row.reportingAmountMinor }), record: JSON.parse(JSON.stringify(row)) })), metrics });
}
