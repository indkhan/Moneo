import { createEvidenceReceipt, evidenceFingerprint, type EvidenceReceipt, type EvidenceReceiptInput } from "./evidence-receipts";
import type { AiDataScope } from "@/lib/settings";
import { publishFinancialClaims } from "./verified-claims";
import { calendarDate } from "./calendar";
export const TOOL_CALCULATION_VERSION = "finance-tools-v1-exact-evidence";
const labels: Record<string, string> = {
  incomeMinor: "Income", spendingMinor: "Spending", netMinor: "Net cashflow", balanceMinor: "Booked balance", amount_minor: "Recorded source posting",
  snapshot_amount_minor: "Dated recorded balance", target_minor: "Goal target", recorded_saved_minor: "Dated recorded savings", reservedMinor: "Virtual reservation",
  targetMinor: "Goal target", recordedSavedMinor: "Dated recorded savings", amountMinor: "Recorded amount",
  planned_monthly_minor: "Planned monthly contribution", plannedMonthlyMinor: "Planned monthly contribution", remainingMinor: "Remaining amount", limitMinor: "Budget limit",
  spentMinor: "Booked budget spending", carriedMinor: "Budget carry", allowanceMinor: "Budget allowance", expectedMinor: "Expected-case forecast",
  conservativeMinor: "Conservative-case forecast", optimisticMinor: "Optimistic-case forecast", availableToSpendMinor: "Conditional account headroom",
  aggregateAvailableMinor: "Conditional aggregate headroom", spendableMinor: "Conditional account headroom",
};
function json(value: unknown) { return JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry)); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function toolSourceVersion(result: unknown): string {
  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !["evaluatedAt", "evaluated_at", "capturedAt", "fetchedAt"].includes(key)).map(([key, child]) => [key, stable(child)]));
    return value;
  }
  return evidenceFingerprint(stable(result));
}
export function toolResultReceipt(name: string, input: unknown, result: unknown, context: { workspaceId: string; fetchedAt: string; timezone: string }, scopes: AiDataScope[]): EvidenceReceipt {
  const sourceVersion = toolSourceVersion(result), sourceId = `${sourceVersion.slice(0, 8)}-${sourceVersion.slice(8, 12)}-5${sourceVersion.slice(13, 16)}-8${sourceVersion.slice(17, 20)}-${sourceVersion.slice(20, 32)}`;
  const metrics: EvidenceReceiptInput["metrics"] = [];
  const today = calendarDate(context.fetchedAt, context.timezone);
  function walk(value: unknown, path: string[], inherited: { currency?: string; period: { from: string; to: string }; qualifiers: EvidenceReceiptInput["metrics"][number]["qualifiers"] }) {
    if (Array.isArray(value)) { value.forEach((child, index) => walk(child, [...path, String(index)], inherited)); return; }
    const row = object(value); if (!Object.keys(row).length) return;
    const currency = [row.currencyCode, row.currency_code, row.currency, inherited.currency].find(item => typeof item === "string") as string | undefined;
    const dated = typeof row.posted_on === "string" ? row.posted_on : typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : typeof row.evaluated_at === "string" ? row.evaluated_at.slice(0, 10) : typeof row.as_of === "string" ? row.as_of.slice(0, 10) : null;
    const named = object(row.period);
    const month = typeof row.month === "string" && /^\d{4}-\d{2}$/.test(row.month) ? row.month : null;
    const monthEnd = month ? new Date(Date.parse(`${month}-01T00:00:00Z`) + 32 * 86400000).toISOString().slice(0, 7) : null;
    const lastMonthDate = monthEnd ? new Date(Date.parse(`${monthEnd}-01T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : null;
    const period = typeof row.from === "string" && typeof row.to === "string" ? { from: row.from, to: row.to }
      : typeof named.from === "string" && typeof named.to === "string" ? { from: named.from, to: named.to }
        : month && lastMonthDate ? { from: `${month}-01`, to: lastMonthDate < today ? lastMonthDate : today }
        : dated ? { from: dated, to: dated } : inherited.period;
    const qualifiers = [...inherited.qualifiers];
    const coverage = object(row.evidence);
    if (coverage.excludedReviewRows && !qualifiers.includes("partial_classification")) qualifiers.push("partial_classification");
    if ((row.classificationStatus === "unresolved" || Array.isArray(row.review_reasons) && row.review_reasons.length || Array.isArray(row.reviewReasons) && row.reviewReasons.length) && !qualifiers.includes("unresolved_included")) qualifiers.push("unresolved_included");
    if (name === "forecast_evaluate" || path.includes("forecast") || path.includes("obligations") || path.includes("goals")) { if (!qualifiers.includes("assumption")) qualifiers.push("assumption"); }
    for (const [key, child] of Object.entries(row)) {
      if ((key === "netWorth" || key === "accountBalanceTotals") && child && typeof child === "object") {
        for (const [code, amount] of Object.entries(child)) if (/^[A-Z]{3}$/.test(code) && (amount === null || typeof amount === "string" && /^-?(?:0|[1-9]\d{0,79})$/.test(amount))) {
          metrics.push({ id: [...path, key, code].join("."), label: key === "netWorth" ? "Net worth" : "Booked account balance total", valueMinor: amount, currency: code,
            period: { from: period.to, to: period.to }, qualifiers: [...new Set([...qualifiers, "dated_snapshot" as const])], sourceIds: [sourceId], calculation: `${name}: deterministic ${key} for ${code}; full dated account/wealth evidence is retained.` });
        }
      } else
      if (Object.hasOwn(labels, key) && currency && (child === null || typeof child === "string" && /^-?(?:0|[1-9]\d{0,79})$/.test(child))) {
        const qualification = [...qualifiers];
        if (key === "amount_minor" && ["transactions_search", "finance_detail"].includes(name)) qualification.push("source_posting");
        if (["snapshot_amount_minor", "recorded_saved_minor", "recordedSavedMinor"].includes(key)) qualification.push("manual_evidence", "dated_snapshot");
        if (key === "reservedMinor") qualification.push("virtual_reservation");
        if (["target_minor", "targetMinor"].includes(key) || key.startsWith("planned")) qualification.push("assumption");
        const manualDate = key === "recordedSavedMinor" && typeof row.savedAsOf === "string" ? row.savedAsOf : key === "snapshot_amount_minor" && typeof row.as_of === "string" ? row.as_of.slice(0, 10) : null;
        metrics.push({ id: [...path, key].join(".") || key, label: key === "amount_minor" && path.includes("balance") ? "Booked balance" : labels[key], valueMinor: child as string | null, currency, period: manualDate ? { from: manualDate, to: manualDate } : period,
          qualifiers: [...new Set(qualification)], sourceIds: [sourceId], calculation: `${name}: exact deterministic field ${[...path, key].join(".")}. Full query inputs, calculation output and supporting record evidence are retained below.` });
      } else if (key !== "calculationEvidence" && key !== "queryInvestigation" && key !== "investigation") walk(child, [...path, key], { currency: /^[A-Z]{3}$/.test(key) ? key : currency, period, qualifiers });
    }
  }
  walk(result, [], { period: { from: today, to: today }, qualifiers: ["partial_coverage"] });
  return createEvidenceReceipt({ workspaceId: context.workspaceId, fetchedAt: context.fetchedAt, calculationVersion: TOOL_CALCULATION_VERSION, sourceVersion, scopes,
    query: json({ kind: "tool", toolName: name, input, result }), sources: [{ id: sourceId, type: "calculation", version: sourceVersion, record: json(result) }], metrics });
}
export const FINANCIAL_ANSWER_INSTRUCTIONS = `Return only a JSON object with claims and interpretation arrays. Each measured claim is {operation:"metric"|"difference"|"sum",operands:[{receiptId,metricId}],valueMinor:exact integer string,currency:exact currency,periods:ordered operand periods,qualifiers:the complete union of required qualification codes}. Difference is first minus second; sum requires identical periods. Source IDs and internal hrefs are never invented: the application renders the actual calculation and supporting records from receipt references. Copy metric and receipt IDs from evidenceReceipts. Do not restate numerical facts or qualitative financial assertions as unrestricted prose. Interpretation is a separate array of {action:"review"|"consider"|"ask",reference:{receiptId,metricId},topic:"classification"|"supporting_records"|"budget"|"timing"|"recurring"|"goals"|"assumptions"}; select conditional next steps related to measured facts. The application labels interpretation distinctly. Unsupported sections are visibly removed; bounded repair budget is zero. Missing evidence stays unknown.`;
export function providerFinancialAnswer(text: string, receipts: EvidenceReceipt[], workspaceId: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  let result = publishFinancialClaims(parsed, receipts, workspaceId);
  if (!result.accepted.length && receipts.some(receipt => receipt.metrics.some(metric => metric.valueMinor !== null))) {
    const all = receipts.flatMap(receipt => receipt.metrics.filter(metric => metric.valueMinor !== null).map(metric => ({ operation: "metric", operands: [{ receiptId: receipt.id, metricId: metric.id }], valueMinor: metric.valueMinor, currency: metric.currency, unit: metric.unit ?? "money", periods: [metric.period], qualifiers: metric.qualifiers })));
    result = publishFinancialClaims({ claims: all.slice(0, 20), interpretation: [] }, receipts, workspaceId);
    result.body += "\n\nUnsupported sections were removed before publication. These supported measures are shown instead." + (all.length > 20 ? " Only the first twenty measures are displayed; the retained calculations contain the remaining evidence." : "");
  }
  if (receipts.length) result.body += `\n\nEvidence trail\n\n${receipts.map(receipt => `- [Retained query and supporting records](/ai/evidence/${receipt.id})`).join("\n")}`;
  return result;
}
