import type { SupabaseClient } from "@supabase/supabase-js";

export type CoverageScope = { from: string; to: string; currencyCode?: string; accountId?: string; accountIds?: string[]; ledgerBasis?: "cashflow" | "balance_activity"; recordBasis?: "manual_wealth" | "manual_goals" };
type EffectiveRow = { account_id?: string; posted_on?: string; currency_code: string; status: string; kind: string; review_reasons?: string[] };
type ImportRow = { id: string; status: string; total_rows: number };
type SourceRow = { import_id: string; status: string; posted_on: string | null; currency_code: string | null; account_id?: string | null; resolved_account_id?: string | null; review_reasons?: string[] };

// Observed posting dates are not statement intervals. Nothing in today's schema
// establishes which statements/accounts are missing or a reconciled-through date.
export function buildSourceCoverage(scope: CoverageScope, rows: EffectiveRow[], imports?: ImportRow[], sources?: SourceRow[]) {
  const effectiveRows = rows.filter(row => (!row.posted_on || row.posted_on >= scope.from && row.posted_on <= scope.to) &&
    (!scope.accountId || row.account_id === scope.accountId) && (!scope.accountIds || row.account_id && scope.accountIds.includes(row.account_id)));
  const exclusions = { pending: 0, transfer: 0, classification: 0, currency: 0 };
  const balanceActivity = scope.ledgerBasis === "balance_activity";
  let includedRows = 0;
  for (const row of effectiveRows) {
    if (row.status !== "posted") exclusions.pending++;
    else if (!balanceActivity && row.review_reasons?.length) exclusions.classification++;
    else if (!balanceActivity && row.kind === "transfer") exclusions.transfer++;
    else if (scope.currencyCode && row.currency_code !== scope.currencyCode) exclusions.currency++;
    else includedRows++;
  }
  const limitations = ["statement_intervals_unknown", "account_coverage_unknown", "reconciliation_freshness_unknown"];
  if (exclusions.classification) limitations.push("unresolved_classifications");
  if (exclusions.currency) limitations.push("currency_conversion_required");
  const unavailable = imports === undefined || sources === undefined;
  const states: Record<string, number> = {};
  for (const item of imports ?? []) states[item.status] = (states[item.status] ?? 0) + 1;
  const undone = new Set((imports ?? []).filter(item => item.status === "undone").map(item => item.id));
  const inScope = (row: SourceRow) => (!row.posted_on || row.posted_on >= scope.from && row.posted_on <= scope.to) &&
    (!scope.currencyCode || !row.currency_code || row.currency_code === scope.currencyCode) &&
    (!scope.accountId || !(row.resolved_account_id ?? row.account_id) || (row.resolved_account_id ?? row.account_id) === scope.accountId) &&
    (!scope.accountIds || !(row.resolved_account_id ?? row.account_id) || scope.accountIds.includes((row.resolved_account_id ?? row.account_id)!));
  const relevant = (sources ?? []).filter(inScope);
  const active = relevant.filter(row => !undone.has(row.import_id));
  const intentionallyExcluded = (row: SourceRow) => row.status === "rejected" && row.review_reasons?.includes("excluded_by_review");
  const intentionalExclusions = active.filter(intentionallyExcluded);
  const unresolved = active.filter(row => !["new", "accepted", "matched", "rejected"].includes(row.status)).length;
  const unknownScope = active.filter(row => !intentionallyExcluded(row) && (!row.posted_on || !row.currency_code || !(row.resolved_account_id ?? row.account_id))).length;
  const activeImports = (imports ?? []).filter(item => item.status !== "undone");
  const unobservedWorkspaceRows = Math.max(0, activeImports.reduce((sum, item) => sum + item.total_rows, 0) -
    (sources ?? []).filter(row => !undone.has(row.import_id)).length);
  if (unavailable) limitations.push("source_access_unavailable");
  if (unresolved) limitations.push("unresolved_source_observations");
  if (unknownScope) limitations.push("source_scope_unknown");
  if (active.some(row => row.status === "rejected")) limitations.push("rejected_source_observations");
  if ((imports ?? []).some(item => !["completed", "undone"].includes(item.status))) limitations.push("import_processing_incomplete");
  if (unobservedWorkspaceRows) limitations.push("import_rows_not_observed; period/account relevance unknown");
  const dates = active.flatMap(row => row.posted_on ? [row.posted_on] : []).sort();
  return { scope: { ...scope, accountScope: scope.accountId ? "selected_account" : scope.accountIds ? "selected_accounts" : "workspace_accepted_accounts" },
    acceptedEffectiveRows: effectiveRows.length, includedRows, exclusions, lifecycleExclusionsKnown: true,
    rowCountScope: balanceActivity ? "posted ledger activity in the dated balance period; snapshot boundaries are evaluated separately" : "cashflow eligibility in the period across all categories; category subtotals have separate attribution",
    observedSourceRows: unavailable ? null : active.length, unresolvedSourceRows: unavailable ? null : unresolved,
    matchedSourceRows: unavailable ? null : active.filter(row => row.status === "matched").length,
    acceptedSourceRows: unavailable ? null : active.filter(row => ["new", "accepted"].includes(row.status)).length,
    rejectedSourceRows: unavailable ? null : active.filter(row => row.status === "rejected").length,
    intentionallyExcludedSourceRows: unavailable ? null : intentionalExclusions.length,
    excludedSourceScopeUnknownRows: unavailable ? null : intentionalExclusions.filter(row => !row.posted_on || !row.currency_code || !row.account_id).length,
    undoneSourceRows: unavailable ? null : relevant.length - active.length,
    unknownSourceScopeRows: unavailable ? null : unknownScope,
    unobservedWorkspaceSourceRows: unavailable ? null : unobservedWorkspaceRows,
    knownAcceptedAccountIds: [...new Set(effectiveRows.flatMap(row => row.account_id ? [row.account_id] : []))].sort(),
    knownAcceptedCurrencies: [...new Set(effectiveRows.map(row => row.currency_code))].sort(),
    observedPostingRange: dates.length ? { from: dates[0], to: dates.at(-1)! } : null,
    importStatuses: unavailable ? null : states, importStatusScope: "workspace; period/account relevance can be unknown",
    statementIntervals: null, reconciledThrough: null, financialCompleteness: "unknown" as const,
    limitations, totalsAreBounds: false as const };
}

export type SourceCoverage = ReturnType<typeof buildSourceCoverage>;

export function sourceCoverageNeedsReview(coverage: SourceCoverage): boolean {
  return coverage.unresolvedSourceRows === null || coverage.unresolvedSourceRows > 0 ||
    (coverage.unknownSourceScopeRows ?? 0) > 0 ||
    (coverage.unobservedWorkspaceSourceRows ?? 0) > 0 ||
    Object.keys(coverage.importStatuses ?? {}).some(status => !["completed", "undone"].includes(status));
}

export async function loadSourceCoverage(db: SupabaseClient, workspaceId: string, scope: CoverageScope,
  rows: EffectiveRow[], canReadImports: boolean): Promise<SourceCoverage> {
  const metadata = await loadSourceCoverageMetadata(db, workspaceId, canReadImports);
  return buildSourceCoverage(scope, rows, metadata?.imports, metadata?.sources);
}

// Internal shared read for readers with several periods/currencies. Consumers
// receive the envelope, never these individual observations or import identities.
export async function loadSourceCoverageMetadata(db: SupabaseClient, workspaceId: string, canReadImports: boolean) {
  if (!canReadImports) return undefined;
  async function all<T>(table: string, columns: string): Promise<T[]> {
    const result: T[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await db.from(table).select(columns).eq("workspace_id", workspaceId).order("id").range(offset, offset + 499);
      if (page.error) throw page.error;
      result.push(...page.data as T[]);
      if (!page.data || page.data.length < 500) return result;
    }
  }
  const [imports, sources] = await Promise.all([
    all<ImportRow>("imports", "id, status, total_rows"),
    // Project only scope metadata: never source descriptions, amounts, mappings or original input.
    all<SourceRow>("source_transactions", "import_id, status, review_reasons, posted_on:normalized_row->row->>postedOn, currency_code:normalized_row->row->>currencyCode, account_id:normalized_row->>accountId, resolved_account_id:normalized_row->resolution->>accountId"),
  ]);
  return { imports, sources };
}
