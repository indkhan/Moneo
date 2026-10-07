import {investigationIdentity, type investigate, type InvestigationSpec} from "./investigation";
import type {ReviewRequest} from "./review-request";

type Result = ReturnType<typeof investigate>;
type Summary = Pick<Result, "queryId" | "evidenceId" | "evidence" | "groups"> & {
  includedRows: number; partial: boolean; groupsOmitted: number;
  records: Pick<Result["records"]["items"][number], "id" | "parentId" | "date" | "amountMinor" | "currency" | "reportingAmountMinor">[];
  supportTotal: number;
};
export type ReviewProgress = {
  version: 1; request: ReviewRequest; startedAt: number; supportRecords: number;
  queries: {query: InvestigationSpec; status: "reading" | "completed" | "unavailable"; receiptId?: string; result?: Summary}[];
  limitations: string[];
};
type Dependencies = {
  read: (query: InvestigationSpec, signal: AbortSignal) => Promise<{result: Result; receiptId: string}>;
  checkpoint?: (progress: ReviewProgress) => Promise<void>;
  now?: () => number; signal?: AbortSignal;
};
const magnitude = (value: string) => {const n = BigInt(value); return n < 0n ? -n : n;};

/** Materiality ordering is local to a currency; round-robin prevents a currency being starved. */
function materialGroups(groups: Result["groups"]) {
  const currencies = new Map<string, Result["groups"]>();
  for (const group of groups) {
    if (group.deltaMinor === null || BigInt(group.deltaMinor) === 0n) continue;
    const bucket = currencies.get(group.currency) ?? [];
    bucket.push(group); currencies.set(group.currency, bucket);
  }
  const buckets = [...currencies.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, bucket]) => bucket.sort((a, b) => {
    const x = magnitude(a.deltaMinor!), y = magnitude(b.deltaMinor!);
    return x > y ? -1 : x < y ? 1 : a.key.localeCompare(b.key);
  }));
  const result: Result["groups"] = [];
  for (let index = 0; buckets.some(bucket => index < bucket.length); index++) for (const bucket of buckets) if (bucket[index]) result.push(bucket[index]);
  return result;
}

/** The caller reads owned deterministic data, persists complete receipts, and fences checkpoints to the current run. */
export async function runReviewInvestigation(request: ReviewRequest, dependencies: Dependencies, previous?: ReviewProgress): Promise<ReviewProgress> {
  if (previous && investigationIdentity(previous.request) !== investigationIdentity(request)) throw new Error("Investigation resume request changed");
  const now = dependencies.now ?? Date.now;
  const progress: ReviewProgress = previous ? structuredClone(previous) : {version: 1, request, startedAt: now(), queries: [], supportRecords: 0, limitations: ["Causal explanations are unproven; only recorded measures and separately labelled hypotheses may be published."]};
  const note = (text: string) => {if (!progress.limitations.includes(text)) progress.limitations.push(text);};
  // A process interrupted during a query still spent that query. Never reset budgets on retry.
  for (const query of progress.queries) if (query.status === "reading") {query.status = "unavailable"; note("An interrupted read was unavailable; its attempt remains counted against the query budget.");}
  const remaining = request.budget.maxDurationMs - (now() - progress.startedAt);
  if (remaining <= 0) {note("Investigation time budget reached; retained supported sections remain available."); await dependencies.checkpoint?.(progress); return progress;}
  const signal = AbortSignal.any([...(dependencies.signal ? [dependencies.signal] : []), AbortSignal.timeout(remaining)]);
  while (progress.queries.length < request.budget.maxQueries && progress.supportRecords < request.budget.maxSupportRecords) {
    if (dependencies.signal?.aborted) throw dependencies.signal.reason;
    if (signal.aborted || now() - progress.startedAt >= request.budget.maxDurationMs) {note("Investigation time budget reached; retained supported sections remain available."); break;}
    const baseline = progress.queries.find(query => query.status === "completed" && !query.query.page.groupKey)?.result;
    const attempted = new Set(progress.queries.map(query => query.query.page.groupKey).filter(Boolean));
    const group = baseline ? materialGroups(baseline.groups).find(candidate => !attempted.has(candidate.key) && candidate.key.length <= 2000) : undefined;
    if (baseline && !group) break;
    const query: InvestigationSpec = {...request.query, page: {size: Math.min(10, request.budget.maxSupportRecords - progress.supportRecords), period: "both", ...(group ? {groupKey: group.key} : {})}};
    const attempt: ReviewProgress["queries"][number] = {query, status: "reading"};
    progress.queries.push(attempt);
    await dependencies.checkpoint?.(progress); // Persist spent budget before starting network work.
    try {
      signal.throwIfAborted();
      const {result, receiptId} = await dependencies.read(query, signal);
      signal.throwIfAborted();
      if (result.records.items.length > query.page.size) throw new Error("Evidence reader exceeded its supporting-record budget");
      const ranked = materialGroups(result.groups);
      // Keep the largest changes, including declines, before filling remaining unchanged groups.
      const groups = [...ranked, ...result.groups.filter(group => !ranked.some(candidate => candidate.key === group.key))].slice(0, 20);
      attempt.result = {queryId: result.queryId, evidenceId: result.evidenceId, evidence: result.evidence, groups,
        groupsOmitted: result.groups.length - groups.length, includedRows: result.coverage.includedRows, partial: result.coverage.partial,
        supportTotal: result.records.total, records: result.records.items.map(({id, parentId, date, amountMinor, currency, reportingAmountMinor}) => ({id, parentId, date, amountMinor, currency, reportingAmountMinor}))};
      attempt.receiptId = receiptId; attempt.status = "completed";
      progress.supportRecords += result.records.items.length;
      if (attempt.result.groupsOmitted) note("Provider context contains the 20 material group measures per query; additional groups remain in the complete retained evidence.");
      if (result.records.total > result.records.items.length) note("Supporting retrieval is bounded; complete calculations and source records remain in the retained evidence.");
      if (baseline && baseline.evidenceId !== result.evidenceId) note("Evidence changed between reads; each retained receipt describes its own dated snapshot, not a single atomic snapshot.");
    } catch (error) {
      if (dependencies.signal?.aborted) throw dependencies.signal.reason;
      attempt.status = "unavailable";
      if (signal.aborted) note("Investigation time budget reached; retained supported sections remain available.");
      else note("Some evidence was unavailable; retained supported sections remain available without an inferred cause.");
      // Do not publish raw transport errors or private source data in the progress summary.
      void error;
    }
    await dependencies.checkpoint?.(progress);
  }
  if (progress.queries.length >= request.budget.maxQueries) note("Investigation query budget reached; further findings may remain unexplored.");
  if (progress.supportRecords >= request.budget.maxSupportRecords) note("Investigation supporting-record budget reached; further findings may remain unexplored.");
  await dependencies.checkpoint?.(progress);
  return progress;
}
