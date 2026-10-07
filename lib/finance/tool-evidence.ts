import { createEvidenceReceipt, evidenceFingerprint, type EvidenceReceipt, type EvidenceReceiptInput } from "./evidence-receipts";
import type { AiDataScope } from "@/lib/settings";
import { publishFinancialClaims } from "./verified-claims";
import { calendarDate } from "./calendar";
import { z } from "zod";
export const TOOL_CALCULATION_VERSION = "finance-tools-v1-exact-evidence";
const labels: Record<string, string> = {
  incomeMinor: "Income", spendingMinor: "Spending", netMinor: "Net cashflow", balanceMinor: "Booked balance", amount_minor: "Recorded source posting",
  snapshot_amount_minor: "Dated recorded balance", snapshotBalanceMinor: "Dated recorded balance", target_minor: "Goal target", recorded_saved_minor: "Dated recorded savings", reservedMinor: "Virtual reservation",
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
  const limitations: NonNullable<EvidenceReceiptInput["limitations"]> = [];
  const today = calendarDate(context.fetchedAt, context.timezone);
  const datedValue = (value: unknown) => typeof value !== "string" ? null : z.iso.date().safeParse(value).success ? value : z.iso.datetime({ offset: true }).safeParse(value).success ? calendarDate(value, context.timezone) : null;
  function walk(value: unknown, path: string[], inherited: { currency?: string; period: { from: string; to: string }; qualifiers: EvidenceReceiptInput["metrics"][number]["qualifiers"] }) {
    if (Array.isArray(value)) { value.forEach((child, index) => walk(child, [...path, String(index)], inherited)); return; }
    const row = object(value); if (!Object.keys(row).length) return;
    for (const field of ["missingInputs", "unavailable", "limitation"] as const) {
      const entries = Array.isArray(row[field]) ? row[field] : [row[field]];
      for (const message of entries) if (typeof message === "string" && message.length && limitations.length < 100) limitations.push({ id: evidenceFingerprint({ path, field, message }), kind: field === "missingInputs" ? "missing_input" : field === "unavailable" ? "unavailable" : "partial", message, nextStep: name === "forecast_evaluate" || path.includes("forecast") ? "assumptions" : "supporting_records" });
    }
    const currency = [row.currencyCode, row.currency_code, row.currency, inherited.currency].find(item => typeof item === "string") as string | undefined;
    const dated = datedValue(row.posted_on) ?? datedValue(row.date) ?? datedValue(row.evaluatedAt ?? row.evaluated_at) ?? datedValue(row.asOf ?? row.as_of);
    const named = object(row.period);
    const forecastStart = datedValue(row.evaluatedOn ?? row.startDate);
    const forecastEnd = forecastStart && typeof row.horizonDays === "number" && Number.isSafeInteger(row.horizonDays) && row.horizonDays >= 1 && row.horizonDays <= 3660
      ? new Date(Date.parse(`${forecastStart}T00:00:00Z`) + (row.horizonDays - 1) * 86400000).toISOString().slice(0, 10) : null;
    const month = typeof row.month === "string" && /^\d{4}-\d{2}$/.test(row.month) ? row.month : null;
    const monthEnd = month ? new Date(Date.parse(`${month}-01T00:00:00Z`) + 32 * 86400000).toISOString().slice(0, 7) : null;
    const lastMonthDate = monthEnd ? new Date(Date.parse(`${monthEnd}-01T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : null;
    const period = forecastStart && forecastEnd ? { from: forecastStart, to: forecastEnd } : typeof row.from === "string" && typeof row.to === "string" ? { from: row.from, to: row.to }
      : typeof named.from === "string" && typeof named.to === "string" ? { from: named.from, to: named.to }
        : month && lastMonthDate ? { from: `${month}-01`, to: today >= `${month}-01` && today < lastMonthDate ? today : lastMonthDate }
        : dated ? { from: dated, to: dated } : inherited.period;
    const qualifiers = [...inherited.qualifiers];
    if ((row.status === "ambiguous" || row.balanceStatus === "ambiguous") && !qualifiers.includes("ambiguous_evidence")) qualifiers.push("ambiguous_evidence");
    const coverage = object(row.evidence);
    const classificationCount = object(object(row.sourceCoverage).exclusions).classification;
    if (([coverage.excludedReviewRows, row.excludedReviewRows, classificationCount].some(count => typeof count === "number" && count > 0) || row.classificationPartial === true) && !qualifiers.includes("partial_classification")) qualifiers.push("partial_classification");
    if (path.includes("budgets") && row.partial === true && !qualifiers.includes("partial_budget")) qualifiers.push("partial_budget");
    if ((row.classificationStatus === "unresolved" || Array.isArray(row.review_reasons) && row.review_reasons.length || Array.isArray(row.reviewReasons) && row.reviewReasons.length) && !qualifiers.includes("unresolved_included")) qualifiers.push("unresolved_included");
    if (name === "forecast_evaluate" || path.includes("forecast") || path.includes("obligations")) { if (!qualifiers.includes("assumption")) qualifiers.push("assumption"); }
    for (const [key, child] of Object.entries(row)) {
      if ((key === "netWorth" || key === "accountBalanceTotals") && child && typeof child === "object") {
        for (const [code, amount] of Object.entries(child)) if (/^[A-Z]{3}$/.test(code) && (amount === null || typeof amount === "string" && /^-?(?:0|[1-9]\d{0,79})$/.test(amount))) {
          metrics.push({ id: [...path, key, code].join("."), label: key === "netWorth" ? "Net worth" : "Booked account balance total", valueMinor: amount, currency: code,
            period: { from: period.to, to: period.to }, qualifiers: [...new Set([...qualifiers, "dated_snapshot" as const])], sourceIds: [sourceId], calculation: `${name}: deterministic ${key} for ${code}; full dated account/wealth evidence is retained.` });
        }
      } else
      if (Object.hasOwn(labels, key) && currency && (child === null || typeof child === "string" && /^-?(?:0|[1-9]\d{0,79})$/.test(child))) {
        const snapshot = key === "snapshot_amount_minor" || key === "snapshotBalanceMinor";
        const snapshotCurrency = row.snapshotCurrencyCode ?? row.snapshot_currency_code;
        const metricCurrency = snapshot ? typeof snapshotCurrency === "string" ? snapshotCurrency : null : currency;
        if (!metricCurrency) continue;
        const qualification = [...qualifiers];
        const component = typeof row.parent_transaction_id === "string";
        const posting = key === "amount_minor" && ["transactions_search", "finance_detail"].includes(name);
        if (posting && !component) qualification.push("source_posting");
        if (snapshot || ["recorded_saved_minor", "recordedSavedMinor"].includes(key) || path.includes("wealth")) qualification.push("manual_evidence", "dated_snapshot");
        if (key === "reservedMinor") qualification.push("virtual_reservation");
        if (["target_minor", "targetMinor", "limitMinor", "allowanceMinor"].includes(key) || key.startsWith("planned")) qualification.push("assumption");
        const manualDate = ["recorded_saved_minor", "recordedSavedMinor"].includes(key) ? datedValue(row.savedAsOf ?? row.saved_as_of) : snapshot ? datedValue(row.asOf ?? row.as_of) : null;
        const postingId = typeof row.id === "string" ? row.id : null;
        const parentId = component ? row.parent_transaction_id as string : postingId;
        const retainedRows = object(object(result).calculationEvidence).rows;
        const aggregateRows = name === "analytics_cashflow" && ["incomeMinor", "spendingMinor", "netMinor"].includes(key) && Array.isArray(retainedRows) ? retainedRows.map(object) : null;
        const aggregation = posting && postingId && parentId ? { kind: "signed-original", ids: [postingId], parents: [parentId], canonicalParents: component ? [] : [parentId] }
          : aggregateRows && aggregateRows.every(item => typeof item.id === "string") ? { kind: `${key.replace("Minor", "")}-${object(object(result).reporting).policy ? "base" : "original"}`, ids: aggregateRows.map(item => item.id as string), parents: [...new Set(aggregateRows.map(item => String(item.parent_transaction_id ?? item.id)))], canonicalParents: [] } : undefined;
        metrics.push({ id: [...path, key].join(".") || key, label: key === "amountMinor" && path.includes("forecast") && path.includes("available") ? "Conditional account headroom" : posting && component ? "Effective allocation component" : path.includes("wealth") && ["amountMinor", "amount_minor"].includes(key) ? "Dated manual wealth value" : key === "amount_minor" && path.includes("balance") ? "Booked balance" : labels[key], valueMinor: child as string | null, currency: metricCurrency, period: manualDate ? { from: manualDate, to: manualDate } : period, ...(aggregation ? { aggregation } : {}),
          qualifiers: [...new Set(qualification)], sourceIds: [sourceId], calculation: `${name}: exact deterministic field ${[...path, key].join(".")}.${datedValue(row.limitingDate) ? ` Limiting date: ${datedValue(row.limitingDate)}.` : ""} Full query inputs, calculation output and supporting record evidence are retained below.` });
      } else if (key !== "calculationEvidence" && key !== "queryInvestigation" && key !== "investigation") walk(child, [...path, key], { currency: /^[A-Z]{3}$/.test(key) ? key : currency, period, qualifiers });
    }
  }
  walk(result, [], { period: { from: today, to: today }, qualifiers: ["partial_coverage"] });
  return createEvidenceReceipt({ workspaceId: context.workspaceId, fetchedAt: context.fetchedAt, calculationVersion: TOOL_CALCULATION_VERSION, sourceVersion, scopes,
    query: json({ kind: "tool", toolName: name, input, result }), sources: [{ id: sourceId, type: "calculation", version: sourceVersion, record: json(result) }], metrics, ...(limitations.length ? { limitations } : {}) });
}
const BASE_FINANCIAL_ANSWER_INSTRUCTIONS = `Return only a JSON object with claims and interpretation arrays. Each measured claim is {operation:"metric"|"difference"|"sum",operands:[{receiptId,metricId}],valueMinor:exact integer string,currency:exact currency,unit:"money"|"count",periods:ordered operand periods,qualifiers:the complete union of required qualification codes}. Copy the unit from evidence metrics (default money); record counts are not currency amounts. Difference is first minus second; sum requires identical periods. Source IDs and internal hrefs are never invented: the application renders the actual calculation and supporting records from receipt references. Copy metric and receipt IDs from evidenceReceipts. Do not restate numerical facts or qualitative financial assertions as unrestricted prose. Interpretation is a separate array of {action:"review"|"consider"|"ask",reference:{receiptId,metricId},topic:"classification"|"supporting_records"|"budget"|"timing"|"recurring"|"goals"|"assumptions"}; select conditional next steps related to measured facts. The application labels interpretation distinctly. Unsupported sections are visibly removed; bounded repair budget is zero. Missing evidence stays unknown.`;
export const FINANCIAL_ANSWER_INSTRUCTIONS = BASE_FINANCIAL_ANSWER_INSTRUCTIONS + ` For evidence-specific explanatory prose, compose interpretation entries {action:"explain",observation:{kind:"comparison",first:{receiptId,metricId},second:{receiptId,metricId},relationship:"higher"|"lower"|"unchanged"},hypotheses:["timing"|"one_off_activity"|"recurring_activity"|"classification"|"missing_data"|"currency_conversion"|"refund_timing"|"changed_allocation"|"internal_funding"|"planned_assumptions"],uncertainty:"unproven",nextSteps:[the supported topic codes]}. Both references must also appear in accepted measured claims, currencies and units must match, and the relationship must agree with exact values. Alternatively use observation:{kind:"limits",reference:{receiptId,metricId}} to explain recorded qualifications. Compose up to four hypotheses/checks per entry and multiple distinct comparisons. The application writes evidence-specific prose using the actual names, dates, exact differences and working links. Hypotheses remain explicitly unproven; do not assert causes, motivations or unrecorded activity. No free-text fields are accepted. For greetings, help or missing scope, keep claims and interpretation empty and add clarification:{topic:"welcome"|"help"|"question"|"period"|"comparison_period"|"account"|"category"|"merchant"|"currency"|"classification"|"goal"|"assumptions"}. These application-written questions introduce no unverified financial assertions. Use an explicit clarification when more context is needed instead of inventing a period, entity or amount.`;
export function providerFinancialAnswer(text: string, receipts: EvidenceReceipt[], workspaceId: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  let result = publishFinancialClaims(parsed, receipts, workspaceId);
  if (!result.accepted.length && !result.clarified && receipts.some(receipt => receipt.metrics.some(metric => metric.valueMinor !== null))) {
    const all = receipts.flatMap(receipt => receipt.metrics.filter(metric => metric.valueMinor !== null).map(metric => ({ operation: "metric", operands: [{ receiptId: receipt.id, metricId: metric.id }], valueMinor: metric.valueMinor, currency: metric.currency, unit: metric.unit ?? "money", periods: [metric.period], qualifiers: metric.qualifiers })));
    result = publishFinancialClaims({ claims: all.slice(0, 20), interpretation: [] }, receipts, workspaceId);
    result.body += "\n\nUnsupported sections were removed before publication. These supported measures are shown instead." + (all.length > 20 ? " Only the first twenty measures are displayed; the retained calculations contain the remaining evidence." : "");
  }
  const retainedLimits = receipts.filter(receipt => receipt.workspaceId === workspaceId).flatMap(receipt => (receipt.limitations ?? []).map(limit => ({ action: "limitation", receiptId: receipt.id, limitationId: limit.id })));
  if (retainedLimits.length) result.body += `\n\n${publishFinancialClaims({ claims: [], interpretation: retainedLimits.slice(0, 20) }, receipts, workspaceId).body}${retainedLimits.length > 20 ? "\n\nOnly the first twenty retained limitations are shown; open the evidence trail for all blocking inputs and qualifications." : ""}`;
  const status = receipts.filter(receipt => receipt.workspaceId === workspaceId).flatMap(receipt => {
    const value = object(receipt.query.result);
    const input = object(receipt.query.input);
    if (receipt.query.toolName === "transactions_setCategory" && z.uuid().safeParse(input.transactionId).success && value.status === "updated" && value.category === input.category && value.transactionUrl === `/money/transactions?transaction=${input.transactionId}`)
      return [`Updated the selected transaction category. [Open transaction and Undo](/money/transactions?transaction=${input.transactionId}).`];
    if (receipt.query.toolName === "transactions_previewCategory") {
      const selected = z.object({ transactionIds: z.array(z.uuid()).min(1).max(50), categoryId: z.uuid() }).safeParse(input);
      const rows = z.array(z.object({ id: z.uuid() }).passthrough()).max(50).safeParse(value.rows);
      if (selected.success && rows.success && object(value.category).id === selected.data.categoryId && new Set(selected.data.transactionIds).size === selected.data.transactionIds.length
        && rows.data.length === selected.data.transactionIds.length && new Set(rows.data.map(row => row.id)).size === rows.data.length && rows.data.every(row => selected.data.transactionIds.includes(row.id)))
        return [`Preview only: review the exact selected entries and explicitly confirm the change in the application. [Open category-change confirmation](/ai/actions/preview?${new URLSearchParams({ ids: selected.data.transactionIds.join(","), category: selected.data.categoryId })}).`];
    }
    if (receipt.query.toolName === "artifacts_create" && z.uuid().safeParse(value.id).success) return [`Created the requested tool: [Open tool](/ai/library/${value.id}).`];
    if (receipt.query.toolName === "reviews_start") return ["The requested review was started. [Track its status](/ai)."]; 
    if (receipt.query.toolName === "imports_status" && Array.isArray(value.imports)) return value.imports.flatMap(raw => {
      const row = object(raw);
      if (!z.uuid().safeParse(row.id).success || !["queued", "processing", "completed", "failed", "canceled", "needs_review"].includes(String(row.status))) return [];
      const count = typeof row.classification_review_rows === "number" && Number.isSafeInteger(row.classification_review_rows) && row.classification_review_rows >= 0 ? ` ${row.classification_review_rows} rows need classification review.` : "";
      return [`[Import records](/import/${row.id}/review): Recorded processing status: ${row.status}.${count} Processing completion does not establish complete financial activity or confirmed classifications.`];
    });
    return [];
  });
  if (status.length) result.body = status.join("\n\n") + (result.accepted.length || result.removed || result.clarified ? `\n\n${result.body}` : "");
  if (receipts.length) result.body += `\n\nEvidence trail\n\n${receipts.filter(receipt => receipt.workspaceId === workspaceId).map(receipt => `- [Retained query and supporting records](/ai/evidence/${receipt.id})`).join("\n")}`;
  return result;
}
