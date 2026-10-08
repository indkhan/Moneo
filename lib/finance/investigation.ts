import { createHash } from "node:crypto";
import { z } from "zod";
import { reportExpenditure, type ExpenditureRate } from "./expenditure";
import { minorDigits } from "./fx";

import { investigationSchema, type InvestigationSpec } from "./investigation-schema";
export { investigationSchema, type InvestigationSpec } from "./investigation-schema";
export type InvestigationRow = {
  id: string; parentId: string; accountId: string; categoryId: string | null; merchantId: string | null;
  date: string; amountMinor: string; currency: string; status: "posted" | "pending"; kind: "ordinary" | "refund" | "transfer";
  tags: string[]; event: string | null; reviewReasons: string[]; version: number; description: string;
  sourceVersions?: unknown; refundOfId?: string | null;
};
export type InvestigationEntities = Record<"accounts" | "categories" | "merchants", { id: string; name: string }[]> & { labels?: { tags: string[]; events: string[] } };
const entityKeys = ["accounts", "categories", "merchants"] as const;
const normalized = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en");

/** Resolve only owned entities; ambiguity is a correction request, never a guessed ID. */
export function resolveInvestigation(input: unknown, entities: InvestigationEntities): InvestigationSpec {
  const spec = investigationSchema.parse(input);
  for (const key of entityKeys) {
    const filter = spec[key];
    if (!filter) continue;
    for (const operation of ["include", "exclude"] as const) {
      filter[operation] = filter[operation]?.map(ref => {
        const matches = entities[key].filter(e => "id" in ref ? e.id === ref.id : normalized(e.name) === normalized(ref.name));
        if (!matches.length) throw new Error(`Unknown owned ${key}: ${"id" in ref ? ref.id : ref.name}`);
        if (matches.length !== 1) throw new Error(`Ambiguous ${key}: ${"name" in ref ? ref.name : ref.id}; choose an ID from the owned entity list`);
        return { id: matches[0].id };
      });
    }
  }
  for (const key of ["tags", "events"] as const) {
    const filter = spec[key], labels = entities.labels?.[key];
    if (!filter || !labels) continue;
    for (const operation of ["include", "exclude"] as const) filter[operation] = filter[operation]?.map(value => {
      const owned = labels.filter(label => normalized(label) === normalized(value)).sort()[0];
      if (!owned) throw new Error(`Unknown owned ${key}: ${value}`);
      // These entities are stored as text labels, not UUIDs. Use the existing stable label.
      return owned;
    });
  }
  return spec;
}

// Sort object keys and set-valued query fields so equivalent requests share identities.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const investigationIdentity = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const abs = (value: bigint) => value < 0n ? -value : value;
const compare = (a: bigint, b: bigint) => a < b ? -1 : a > b ? 1 : 0;
function entityMatches(filter: InvestigationSpec["accounts"], id: string | null) {
  if ([...(filter?.include ?? []), ...(filter?.exclude ?? [])].some(ref => !("id" in ref))) throw new Error("Resolve entity names before querying");
  const included = filter?.include;
  return (!included?.length || included.some(ref => "id" in ref && ref.id === id)) && !filter?.exclude?.some(ref => "id" in ref && ref.id === id);
}
function labelsMatch(filter: InvestigationSpec["tags"], labels: string[]) {
  const values = labels.map(normalized);
  return (!filter?.include?.length || filter.include.some(label => values.includes(normalized(label)))) && !filter?.exclude?.some(label => values.includes(normalized(label)));
}
function metricValue(row: InvestigationRow, metric: InvestigationSpec["metric"]) {
  const amount = BigInt(row.amountMinor);
  if (metric === "count") return 1n;
  if (metric === "absolute") return abs(amount);
  if (metric === "signed") return amount;
  // Transfer principals are gross flows, never financial income/spending/net.
  if (row.kind === "transfer") return 0n;
  if (metric === "net") return amount;
  if (metric === "income") return row.kind !== "refund" && amount > 0n ? amount : 0n;
  return row.kind === "refund" || amount < 0n ? -amount : 0n;
}
export function investigationGroup(row: InvestigationRow, dimensions: InvestigationSpec["groupBy"]) {
  return Object.fromEntries(dimensions.map(d => [d,
    d === "account" ? row.accountId : d === "category" ? row.categoryId : d === "merchant" ? row.merchantId :
      // Tags are a set-valued partition: a record belongs once, never once per tag.
      d === "tag" ? [...new Set(row.tags)].sort() : d === "event" ? row.event : d === "date" ? row.date : d === "month" ? row.date.slice(0, 7) : row[d],
  ]));
}
export type InvestigationContext = { workspaceId: string; capturedAt: string; sourceCoverage?: unknown; rates?: ExpenditureRate[]; entities?: InvestigationEntities };

function allocatedReporting(rows: InvestigationRow[], spec: InvestigationSpec, rates: ExpenditureRate[]) {
  if (spec.currencyPolicy.mode !== "base") return null;
  if (spec.statuses.some(s => s !== "posted") || spec.classifications !== "resolved" || spec.kinds.includes("transfer")) throw new Error("Base currency accounting requires posted, resolved ordinary/refund records; use original currency for provisional or transfer analysis");
  const from = [spec.period.from, spec.comparison?.from].filter((v): v is string => Boolean(v)).sort()[0];
  const to = [spec.period.to, spec.comparison?.to].filter((v): v is string => Boolean(v)).sort().at(-1)!;
  const report = reportExpenditure(rows.map(r => ({ id: r.id, parentTransactionId: r.parentId, accountId: r.accountId,
    amountMinor: BigInt(r.amountMinor), currencyCode: r.currency, postedOn: r.date, status: r.status, kind: r.kind, reviewReasons: r.reviewReasons, version: r.version })), rates, { view: "base", currencyCode: spec.currencyPolicy.currency, from, to });
  const allocated = new Map<string, string | null>();
  for (const posting of report.postings) {
    if (posting.reportingAmountMinor === null || !posting.rate || !posting.rounding) {
      for (const child of posting.sourcePostings) allocated.set(child.id, null);
      continue;
    }
    const denominator = BigInt(posting.rounding.scaledDenominator);
    const multiplier = BigInt(posting.rate.numerator) * 10n ** BigInt(minorDigits(spec.currencyPolicy.currency));
    const shares = posting.sourcePostings.map(child => {
      const scaled = BigInt(child.originalAmountMinor) * multiplier;
      let floor = scaled / denominator, remainder = scaled % denominator;
      if (remainder < 0n) { floor--; remainder += denominator; }
      return { id: child.id, floor, remainder };
    });
    let remaining = BigInt(posting.reportingAmountMinor) - shares.reduce((sum, share) => sum + share.floor, 0n);
    for (const share of shares.sort((a, b) => compare(b.remainder, a.remainder) || a.id.localeCompare(b.id))) {
      if (remaining > 0n) { share.floor++; remaining--; }
      allocated.set(share.id, share.floor.toString());
    }
    if (remaining !== 0n) throw new Error("Inconsistent canonical reporting allocation");
  }
  return { report: { ...report, allocationPolicy: "largest-remainder of exact signed component quotas; canonical rounded amount conserved; ties by effective ID" }, allocated };
}

/** All effective records are loaded before totals; pagination applies solely to support. No financial writes. */
export function investigate(input: unknown, rows: InvestigationRow[], context: InvestigationContext, options: { retainSupport?: boolean } = {}) {
  const spec = investigationSchema.parse(input);
  const { page, ...meaning } = spec;
  const reporting = allocatedReporting(rows, spec, context.rates ?? []);
  const queryId = investigationIdentity({ workspaceId: context.workspaceId, ...meaning });
  const evidenceId = investigationIdentity({ queryId, rows: [...rows].sort((a, b) => a.id.localeCompare(b.id)), sourceCoverage: context.sourceCoverage ?? null, reporting: reporting?.report ?? null });
  const excluded = { outsidePeriod: 0, filtersExcluded: 0, statusExcluded: 0, pendingExcluded: 0, postedExcluded: 0, kindExcluded: 0, transferExcluded: 0, classificationExcluded: 0, currencyExcluded: 0 };
  const selected: { row: InvestigationRow; current: boolean; comparison: boolean; key: string }[] = [];
  const groups = new Map<string, { key: string; dimensions: ReturnType<typeof investigationGroup>; currency: string; current: bigint; comparison: bigint; currentCount: number; comparisonCount: number; supportCount: number; missingCurrent: number; missingComparison: number }>();
  let unresolvedIncluded = 0;
  let missingConversionRows = 0;
  for (const row of rows) {
    const current = row.date >= spec.period.from && row.date <= spec.period.to;
    const comparison = Boolean(spec.comparison && row.date >= spec.comparison.from && row.date <= spec.comparison.to);
    if (!current && !comparison) { excluded.outsidePeriod++; continue; }
    if (!entityMatches(spec.accounts, row.accountId) || !entityMatches(spec.categories, row.categoryId) || !entityMatches(spec.merchants, row.merchantId) || !labelsMatch(spec.tags, row.tags) || !labelsMatch(spec.events, row.event ? [row.event] : [])) { excluded.filtersExcluded++; continue; }
    if (!spec.statuses.includes(row.status)) { excluded.statusExcluded++; if (row.status === "pending") excluded.pendingExcluded++; else excluded.postedExcluded++; continue; }
    if (!spec.kinds.includes(row.kind)) { excluded.kindExcluded++; if (row.kind === "transfer") excluded.transferExcluded++; continue; }
    if ((spec.classifications === "resolved" && row.reviewReasons.length) || (spec.classifications === "unresolved" && !row.reviewReasons.length)) { excluded.classificationExcluded++; continue; }
    if (spec.currencyPolicy.mode === "original" && spec.currencyPolicy.currencies && !spec.currencyPolicy.currencies.includes(row.currency)) { excluded.currencyExcluded++; continue; }
    if (row.reviewReasons.length) unresolvedIncluded++;
    const dimensions = investigationGroup(row, spec.groupBy);
    const currency = spec.currencyPolicy.mode === "base" ? spec.currencyPolicy.currency : row.currency;
    const key = JSON.stringify([currency, dimensions]);
    const group = groups.get(key) ?? { key, dimensions, currency, current: 0n, comparison: 0n, currentCount: 0, comparisonCount: 0, supportCount: 0, missingCurrent: 0, missingComparison: 0 };
    const converted = reporting?.allocated.get(row.id);
    const missing = reporting !== null && converted == null && spec.metric !== "count";
    if (missing) { missingConversionRows++; if (current) group.missingCurrent++; if (comparison) group.missingComparison++; }
    const value = missing ? 0n : metricValue(reporting && converted != null ? { ...row, amountMinor: converted } : row, spec.metric);
    if (current) { group.current += value; group.currentCount++; }
    if (comparison) { group.comparison += value; group.comparisonCount++; }
    group.supportCount++;
    groups.set(key, group);
    selected.push({ row, current, comparison, key });
  }
  const sorted = [...groups.values()].sort((a, b) => {
    const deltaA = a.current - a.comparison, deltaB = b.current - b.comparison;
    const amountOrder = spec.sort === "delta-desc" ? compare(deltaB, deltaA) : spec.sort === "delta-asc" ? compare(deltaA, deltaB) : spec.sort === "absolute-delta-desc" ? compare(abs(deltaB), abs(deltaA)) : spec.sort === "current-desc" ? compare(b.current, a.current) : spec.sort === "current-asc" ? compare(a.current, b.current) : 0;
    // No ranking across currencies: exact minor units are comparable only within a currency.
    return a.currency.localeCompare(b.currency) || amountOrder || a.key.localeCompare(b.key);
  });
  if (page.groupKey && !groups.has(page.groupKey)) throw new Error("Unknown investigation group");
  const supporting = selected.filter(s => (!page.groupKey || s.key === page.groupKey) && (page.period === "both" || s[page.period])).sort((a, b) => b.row.date.localeCompare(a.row.date) || a.row.id.localeCompare(b.row.id));
  let offset = 0;
  if (page.cursor) {
    let cursor: unknown;
    try { cursor = JSON.parse(Buffer.from(page.cursor, "base64url").toString("utf8")); } catch { throw new Error("Invalid investigation cursor"); }
    const parsed = z.object({ evidenceId: z.string(), offset: z.number().int().nonnegative(), scope: z.string() }).strict().parse(cursor);
    if (parsed.evidenceId !== evidenceId || parsed.scope !== investigationIdentity({ groupKey: page.groupKey ?? null, period: page.period })) throw new Error("Investigation evidence or supporting scope changed; restart pagination");
    offset = parsed.offset;
  }
  const nextOffset = offset + page.size;
  const record = ({ row, current, comparison, key }: typeof selected[number]) => ({ ...row, current, comparison, groupKey: key, reportingAmountMinor: reporting ? reporting.allocated.get(row.id) ?? null : null, link: `/money/transactions?transaction=${encodeURIComponent(row.parentId)}` });
  const selectedIds = new Set(selected.map(item => item.row.id));
  const selectedParents = new Set(selected.map(item => item.row.parentId));
  return {
    version: 1 as const, queryId, evidenceId, evidence: { mode: "live" as const, capturedAt: context.capturedAt, datedSnapshot: false },
    interpretedFilters: meaning, metric: spec.metric, currencyPolicy: spec.currencyPolicy,
    reporting: reporting ? { currency: spec.currencyPolicy.mode === "base" ? spec.currencyPolicy.currency : null,
      policy: reporting.report.policy, allocationPolicy: reporting.report.allocationPolicy,
      postings: reporting.report.postings.filter(p => p.sourcePostings.some(s => selectedIds.has(s.id))),
      exclusions: reporting.report.exclusions.filter(exclusion => selectedParents.has(exclusion.id) || selectedIds.has(exclusion.id)),
      basis: "Canonical conversion before entity filters; groups contain only the selected allocated components." } : null,
    groups: sorted.map(g => ({ key: g.key, dimensions: g.dimensions, currency: g.currency, currentMinor: g.missingCurrent ? null : g.current.toString(), comparisonMinor: spec.comparison && !g.missingComparison ? g.comparison.toString() : null, deltaMinor: spec.comparison && !g.missingCurrent && !g.missingComparison ? (g.current - g.comparison).toString() : null, availableCurrentMinor: g.current.toString(), availableComparisonMinor: g.comparison.toString(), currentCount: g.currentCount, comparisonCount: g.comparisonCount, supportCount: g.supportCount })),
    coverage: { ...excluded, effectiveRowsObserved: rows.length, includedRows: selected.length, unresolvedIncluded, missingConversionRows, partial: excluded.classificationExcluded > 0 || unresolvedIncluded > 0 || missingConversionRows > 0, sourceCoverage: context.sourceCoverage ?? { status: "unknown", statementCompleteness: "unknown" }, limitation: "Accepted/effective ledger scope only. Classification exclusions, unresolved amounts and missing conversions are not upper or lower bounds. Statement completeness is determined separately by source coverage." },
    records: { total: supporting.length, items: supporting.slice(offset, nextOffset).map(record), nextCursor: nextOffset < supporting.length ? Buffer.from(JSON.stringify({ evidenceId, offset: nextOffset, scope: investigationIdentity({ groupKey: page.groupKey ?? null, period: page.period }) })).toString("base64url") : null },
    ...(options.retainSupport ? { retainedRecords: selected.map(record) } : {}),
  };
}
