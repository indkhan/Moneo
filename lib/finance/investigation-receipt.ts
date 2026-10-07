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
  const limitations: NonNullable<EvidenceReceiptInput["limitations"]> = (result.reporting?.exclusions ?? [])
    .filter(row => ["missing-rate", "ambiguous-rate", "invalid-rate"].includes(row.reason))
    .slice(0, 100).map(row => ({ id: evidenceFingerprint(row), kind: "unavailable", nextStep: "supporting_records",
      message: `Conversion unavailable (${row.reason}) for ${row.currencyCode} to ${result.reporting!.currency} on ${row.postedOn}. Supply one valid direct posting-date rate or choose original-currency analysis. Affected period/group totals are unavailable; converted subsets are not upper or lower bounds.` }));
  const caption = (text: string) => text.length > 200 ? `${text.slice(0, 197)}...` : text;
  const metrics: EvidenceReceiptInput["metrics"] = result.groups.flatMap(group => {
    const key = evidenceFingerprint(group.key).slice(0, 32);
    const support = records.filter(row => row.groupKey === group.key);
    const aggregation = (rows: typeof support) => ({ kind: `${spec.metric}-${spec.currencyPolicy.mode}`, ids: rows.map(row => row.id), parents: [...new Set(rows.map(row => row.parentId))], canonicalParents: [] });
    const common = { currency: group.currency, unit: spec.metric === "count" ? "count" as const : "money" as const, qualifiers, calculation: `Sum the ${spec.metric} contribution of each retained effective record once under the complete filters and group dimensions retained below. Spending subtracts refunds; accounting income/spending/net exclude transfer principals; signed/absolute/count retain selected gross flows. ${result.reporting ? `${result.reporting.policy}; ${result.reporting.allocationPolicy}.` : "Original-currency exact minor units."}` };
    return [{ ...common, aggregation: aggregation(support.filter(row => row.current)), id: `${key}:current`, label: caption(`${spec.metric} ${JSON.stringify(group.dimensions)}`), valueMinor: group.currentMinor, period: spec.period, sourceIds: support.filter(row => row.current).map(row => row.id) },
      ...(spec.comparison ? [{ ...common, aggregation: aggregation(support.filter(row => row.comparison)), id: `${key}:comparison`, label: caption(`${spec.metric} ${JSON.stringify(group.dimensions)}`), valueMinor: group.comparisonMinor, period: spec.comparison, sourceIds: support.filter(row => row.comparison).map(row => row.id) },
        { ...common, id: `${key}:delta`, label: caption(`${spec.metric} change: ${spec.period.from} to ${spec.period.to} compared with ${spec.comparison.from} to ${spec.comparison.to} ${JSON.stringify(group.dimensions)}`), calculation: `Current total (${spec.period.from} to ${spec.period.to}) minus comparison total (${spec.comparison.from} to ${spec.comparison.to}). ${common.calculation}`, valueMinor: group.deltaMinor, period: spec.period, sourceIds: support.map(row => row.id) }] : [])];
  });
  return createEvidenceReceipt({ workspaceId: dataset.context.workspaceId, fetchedAt: dataset.context.capturedAt, calculationVersion: INVESTIGATION_CALCULATION_VERSION, sourceVersion: dataset.sourceRevision,
    scopes, query: JSON.parse(JSON.stringify({ kind: "investigation", spec, groups: result.groups, sourceCoverage: result.coverage.sourceCoverage, reporting: result.reporting })),
    sources: records.map(row => ({ id: row.id, entityId: row.parentId, type: "transaction", version: evidenceFingerprint({ version: row.version, sources: row.sourceVersions, amount: row.amountMinor, reportingAmount: row.reportingAmountMinor }), record: JSON.parse(JSON.stringify(row)) })), metrics, ...(limitations.length ? { limitations } : {}) });
}
