import { createEvidenceReceipt, evidenceFingerprint, type EvidenceReceipt, type EvidenceReceiptInput } from "./evidence-receipts";
import type { AiDataScope } from "@/lib/settings";
import { calendarDate } from "./calendar";
import { sourceCoverageNeedsReview, type SourceCoverage } from "./source-coverage";
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
    // Coverage is flagged only when the recorded sources actually show gaps.
    const sources = object(row.sourceCoverage);
    if (Object.keys(sources).length && sourceCoverageNeedsReview(sources as SourceCoverage) && !qualifiers.includes("partial_coverage")) qualifiers.push("partial_coverage");
    const coverage = object(row.evidence);
    const classificationCount = object(object(row.sourceCoverage).exclusions).classification;
    if (([coverage.excludedReviewRows, row.excludedReviewRows, classificationCount].some(count => typeof count === "number" && count > 0) || row.classificationPartial === true) && !qualifiers.includes("partial_classification")) qualifiers.push("partial_classification");
    if (path.includes("budgets") && row.partial === true && !qualifiers.includes("partial_budget")) qualifiers.push("partial_budget");
    if ((row.classificationStatus === "unresolved" || Array.isArray(row.review_reasons) && row.review_reasons.length || Array.isArray(row.reviewReasons) && row.reviewReasons.length) && !qualifiers.includes("unresolved_included")) qualifiers.push("unresolved_included");
    if (name === "forecast_evaluate" || path.includes("forecast") || path.includes("obligations")) { if (!qualifiers.includes("assumption")) qualifiers.push("assumption"); }
    for (const [key, child] of Object.entries(row)) {
      if ((key === "netWorth" || key === "accountBalanceTotals") && child && typeof child === "object") {
        for (const [code, amount] of Object.entries(child)) if (/^[A-Z]{3}$/.test(code) && (amount === null || typeof amount === "string" && /^-?(?:0|[1-9]\d{0,79})$/.test(amount))) {
          const accounts = Array.isArray(row.accounts) ? row.accounts.map(object) : [];
          const wealth = object(object(row.planning).wealth);
          const includedWealth = Array.isArray(wealth.included) ? wealth.included.map(object) : [];
          const manual = accounts.some(account => account.currencyCode === code && account.balanceMinor !== null && typeof account.provenance === "string" && /^manual\b/.test(account.provenance))
            || key === "netWorth" && includedWealth.some(item => item.currencyCode === code);
          metrics.push({ id: [...path, key, code].join("."), label: key === "netWorth" ? "Net worth" : "Booked account balance total", valueMinor: amount, currency: code,
            period: { from: period.to, to: period.to }, qualifiers: [...new Set([...qualifiers, "dated_snapshot" as const, ...(manual ? ["manual_evidence" as const] : [])])], sourceIds: [sourceId], calculation: `${name}: deterministic ${key} for ${code}; full dated account/wealth evidence is retained.` });
        }
      } else
      if (Object.hasOwn(labels, key) && currency && (child === null || typeof child === "string" && /^-?(?:0|[1-9]\d{0,79})$/.test(child))) {
        const snapshot = key === "snapshot_amount_minor" || key === "snapshotBalanceMinor";
        const bookedBalance = key === "balanceMinor" || key === "amount_minor" && path.includes("balance");
        const manualBalance = (snapshot || bookedBalance) && typeof row.provenance === "string" && /^manual\b/.test(row.provenance);
        const goalRemainder = key === "remainingMinor" && (Object.hasOwn(row, "savedAsOf") || Object.hasOwn(row, "saved_as_of"));
        const savedEvidence = ["recorded_saved_minor", "recordedSavedMinor"].includes(key) || goalRemainder;
        const snapshotCurrency = row.snapshotCurrencyCode ?? row.snapshot_currency_code;
        const metricCurrency = snapshot ? typeof snapshotCurrency === "string" ? snapshotCurrency : null : currency;
        if (!metricCurrency) continue;
        const qualification = [...qualifiers];
        const component = typeof row.parent_transaction_id === "string" || typeof row.parentId === "string";
        const posting = ["amount_minor", "amountMinor"].includes(key) && ["transactions_search", "finance_detail"].includes(name);
        if (posting && !component) qualification.push("source_posting");
        if (snapshot || bookedBalance || savedEvidence || path.includes("wealth")) qualification.push("dated_snapshot");
        if (manualBalance || savedEvidence || path.includes("wealth")) qualification.push("manual_evidence");
        if (goalRemainder) qualification.push("assumption");
        if (key === "reservedMinor") qualification.push("virtual_reservation");
        if (["target_minor", "targetMinor", "limitMinor", "allowanceMinor"].includes(key) || key.startsWith("planned")) qualification.push("assumption");
        const manualDate = savedEvidence ? datedValue(row.savedAsOf ?? row.saved_as_of) : snapshot || manualBalance ? datedValue(row.asOf ?? row.as_of) : null;
        const limitingDate = datedValue(key === "spendableMinor" ? row.spendingLimitingDate : key === "aggregateAvailableMinor" ? row.aggregateLimitingDate : row.limitingDate);
        const postingId = typeof row.id === "string" ? row.id : null;
        const parentId = component ? (row.parent_transaction_id ?? row.parentId) as string : postingId;
        const retainedRows = object(object(result).calculationEvidence).rows;
        const aggregateRows = name === "analytics_cashflow" && ["incomeMinor", "spendingMinor", "netMinor"].includes(key) && Array.isArray(retainedRows) ? retainedRows.map(object) : null;
        const aggregation = posting && postingId && parentId ? { kind: "signed-original", ids: [postingId], parents: [parentId], canonicalParents: component ? [] : [parentId] }
          : aggregateRows && aggregateRows.every(item => typeof item.id === "string") ? { kind: `${key.replace("Minor", "")}-${object(object(result).reporting).policy ? "base" : "original"}`, ids: aggregateRows.map(item => item.id as string), parents: [...new Set(aggregateRows.map(item => String(item.parent_transaction_id ?? item.id)))], canonicalParents: [] } : undefined;
        metrics.push({ id: [...path, key].join(".") || key, label: key === "amountMinor" && path.includes("forecast") && path.includes("available") ? "Conditional aggregate headroom" : posting && component ? "Effective allocation component" : path.includes("wealth") && ["amountMinor", "amount_minor"].includes(key) ? "Dated manual wealth value" : key === "amount_minor" && path.includes("balance") ? "Booked balance" : labels[key], valueMinor: child as string | null, currency: metricCurrency, period: manualDate ? { from: manualDate, to: manualDate } : period, ...(aggregation ? { aggregation } : {}),
          qualifiers: [...new Set(qualification)], sourceIds: [sourceId], calculation: `${name}: exact deterministic field ${[...path, key].join(".")}.${goalRemainder ? ` Goal target minus dated manual recorded savings (savedAsOf: ${manualDate ?? "unavailable"}); the target is an assumption and this remainder does not verify current savings or affordability.` : ""}${limitingDate ? ` Limiting date: ${limitingDate}.` : ""} Full query inputs, calculation output and supporting record evidence are retained below.` });
      } else if (key !== "calculationEvidence" && key !== "queryInvestigation" && key !== "investigation") walk(child, [...path, key], { currency: /^[A-Z]{3}$/.test(key) ? key : currency, period, qualifiers });
    }
  }
  walk(result, [], { period: { from: today, to: today }, qualifiers: [] });
  return createEvidenceReceipt({ workspaceId: context.workspaceId, fetchedAt: context.fetchedAt, calculationVersion: TOOL_CALCULATION_VERSION, sourceVersion, scopes,
    query: json({ kind: "tool", toolName: name, input, result }), sources: [{ id: sourceId, type: "calculation", version: sourceVersion, record: json(result) }], metrics, ...(limitations.length ? { limitations: [...new Map(limitations.map(limit => [limit.id, limit])).values()] } : {}) });
}
