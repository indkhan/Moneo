import { createHash } from "node:crypto";
import { z } from "zod";

const period = z.object({ from: z.iso.date(), to: z.iso.date() }).strict().refine(p => p.from <= p.to, "From date is after to date");
const entity = z.union([z.object({ id: z.uuid() }).strict(), z.object({ name: z.string().trim().min(1).max(120) }).strict()]);
const entityFilter = z.object({ include: z.array(entity).max(100).optional(), exclude: z.array(entity).max(100).optional() }).strict();
const labelFilter = z.object({ include: z.array(z.string().trim().min(1).max(120)).max(100).optional(), exclude: z.array(z.string().trim().min(1).max(120)).max(100).optional() }).strict();
export const investigationSchema = z.object({
  version: z.literal(1), period, comparison: period.optional(),
  accounts: entityFilter.optional(), categories: entityFilter.optional(), merchants: entityFilter.optional(),
  tags: labelFilter.optional(), events: labelFilter.optional(),
  statuses: z.array(z.enum(["posted", "pending"])).min(1).max(2).default(["posted"]),
  classifications: z.enum(["resolved", "all", "unresolved"]).default("resolved"),
  kinds: z.array(z.enum(["ordinary", "refund", "transfer"])).min(1).max(3).default(["ordinary", "refund"]),
  currencyPolicy: z.object({ mode: z.literal("original"), currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(50).optional() }).strict().default({ mode: "original" }),
  metric: z.enum(["spending", "income", "net", "signed", "absolute", "count"]).default("spending"),
  groupBy: z.array(z.enum(["account", "category", "merchant", "tag", "event", "date", "month", "kind", "status"])).max(5).default([]).refine(a => new Set(a).size === a.length, "Duplicate grouping dimension"),
  sort: z.enum(["delta-desc", "delta-asc", "absolute-delta-desc", "current-desc", "current-asc", "key"]).default("absolute-delta-desc"),
  page: z.object({ size: z.number().int().min(1).max(100).default(25), cursor: z.string().max(1000).optional(), groupKey: z.string().max(2000).optional(), period: z.enum(["current", "comparison", "both"]).default("both") }).strict().default({ size: 25, period: "both" }),
}).strict();
export type InvestigationSpec = z.infer<typeof investigationSchema>;
export type InvestigationRow = {
  id: string; parentId: string; accountId: string; categoryId: string | null; merchantId: string | null;
  date: string; amountMinor: string; currency: string; status: "posted" | "pending"; kind: "ordinary" | "refund" | "transfer";
  tags: string[]; event: string | null; reviewReasons: string[]; version: number; description: string;
  sourceVersions?: unknown; refundOfId?: string | null;
};
export type InvestigationEntities = Record<"accounts" | "categories" | "merchants", { id: string; name: string }[]>;
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
  if (metric === "signed" || metric === "net") return amount;
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
export type InvestigationContext = { workspaceId: string; capturedAt: string; sourceCoverage?: unknown };

/** All effective records are loaded before totals; pagination applies solely to support. No financial writes. */
export function investigate(input: unknown, rows: InvestigationRow[], context: InvestigationContext) {
  const spec = investigationSchema.parse(input);
  const { page, ...meaning } = spec;
  const queryId = investigationIdentity({ workspaceId: context.workspaceId, ...meaning });
  const evidenceId = investigationIdentity({ queryId, rows: [...rows].sort((a, b) => a.id.localeCompare(b.id)), sourceCoverage: context.sourceCoverage ?? null });
  const excluded = { outsidePeriod: 0, filtersExcluded: 0, pendingExcluded: 0, transferExcluded: 0, classificationExcluded: 0, currencyExcluded: 0 };
  const selected: { row: InvestigationRow; current: boolean; comparison: boolean; key: string }[] = [];
  const groups = new Map<string, { key: string; dimensions: ReturnType<typeof investigationGroup>; currency: string; current: bigint; comparison: bigint; currentCount: number; comparisonCount: number }>();
  let unresolvedIncluded = 0;
  for (const row of rows) {
    const current = row.date >= spec.period.from && row.date <= spec.period.to;
    const comparison = Boolean(spec.comparison && row.date >= spec.comparison.from && row.date <= spec.comparison.to);
    if (!current && !comparison) { excluded.outsidePeriod++; continue; }
    if (!entityMatches(spec.accounts, row.accountId) || !entityMatches(spec.categories, row.categoryId) || !entityMatches(spec.merchants, row.merchantId) || !labelsMatch(spec.tags, row.tags) || !labelsMatch(spec.events, row.event ? [row.event] : [])) { excluded.filtersExcluded++; continue; }
    if (!spec.statuses.includes(row.status)) { excluded.pendingExcluded++; continue; }
    if (!spec.kinds.includes(row.kind)) { excluded.transferExcluded++; continue; }
    if ((spec.classifications === "resolved" && row.reviewReasons.length) || (spec.classifications === "unresolved" && !row.reviewReasons.length)) { excluded.classificationExcluded++; continue; }
    if (spec.currencyPolicy.currencies && !spec.currencyPolicy.currencies.includes(row.currency)) { excluded.currencyExcluded++; continue; }
    if (row.reviewReasons.length) unresolvedIncluded++;
    const dimensions = investigationGroup(row, spec.groupBy);
    const key = JSON.stringify([row.currency, dimensions]);
    const group = groups.get(key) ?? { key, dimensions, currency: row.currency, current: 0n, comparison: 0n, currentCount: 0, comparisonCount: 0 };
    const value = metricValue(row, spec.metric);
    if (current) { group.current += value; group.currentCount++; }
    if (comparison) { group.comparison += value; group.comparisonCount++; }
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
  const record = ({ row, current, comparison, key }: typeof selected[number]) => ({ ...row, current, comparison, groupKey: key, link: `/money/transactions?transaction=${encodeURIComponent(row.parentId)}` });
  return {
    version: 1 as const, queryId, evidenceId, evidence: { mode: "live" as const, capturedAt: context.capturedAt, datedSnapshot: false },
    interpretedFilters: meaning, metric: spec.metric, currencyPolicy: spec.currencyPolicy,
    groups: sorted.map(g => ({ key: g.key, dimensions: g.dimensions, currency: g.currency, currentMinor: g.current.toString(), comparisonMinor: spec.comparison ? g.comparison.toString() : null, deltaMinor: spec.comparison ? (g.current - g.comparison).toString() : null, currentCount: g.currentCount, comparisonCount: g.comparisonCount })),
    coverage: { ...excluded, effectiveRowsObserved: rows.length, includedRows: selected.length, unresolvedIncluded, partial: excluded.classificationExcluded > 0 || unresolvedIncluded > 0, sourceCoverage: context.sourceCoverage ?? { status: "unknown", statementCompleteness: "unknown" }, limitation: "Accepted/effective ledger scope only. Classification exclusions and unresolved amounts are not upper or lower bounds. Statement completeness is determined separately by source coverage." },
    records: { total: supporting.length, items: supporting.slice(offset, nextOffset).map(record), nextCursor: nextOffset < supporting.length ? Buffer.from(JSON.stringify({ evidenceId, offset: nextOffset, scope: investigationIdentity({ groupKey: page.groupKey ?? null, period: page.period }) })).toString("base64url") : null },
  };
}
