import type { SupabaseClient } from "@supabase/supabase-js";

export type CoverageScope = { from: string; to: string; currencyCode?: string; accountId?: string };
type EffectiveRow = { account_id?: string; currency_code: string; status: string; kind: string; review_reasons?: string[] };
type ImportRow = { id: string; status: string; total_rows: number };
type SourceRow = { import_id: string; status: string; posted_on: string | null; currency_code: string | null; account_id?: string | null };

// Observed posting dates are not statement intervals. Nothing in today's schema
// establishes which statements/accounts are missing or a reconciled-through date.
export function buildSourceCoverage(scope: CoverageScope, rows: EffectiveRow[], imports?: ImportRow[], sources?: SourceRow[]) {
  const exclusions = { pending: 0, transfer: 0, classification: 0, currency: 0 };
  let includedRows = 0;
  for (const row of rows) {
    if (row.status !== "posted") exclusions.pending++;
    else if (row.review_reasons?.length) exclusions.classification++;
    else if (row.kind === "transfer") exclusions.transfer++;
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
    (!scope.accountId || !row.account_id || row.account_id === scope.accountId);
  const relevant = (sources ?? []).filter(inScope);
  const active = relevant.filter(row => !undone.has(row.import_id));
  const unresolved = active.filter(row => !["new", "matched", "rejected"].includes(row.status)).length;
  const unknownScope = active.filter(row => !row.posted_on || !row.currency_code || !row.account_id).length;
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
  return { scope: { ...scope, accountScope: scope.accountId ? "selected_account" : "workspace_accepted_accounts" },
    acceptedEffectiveRows: rows.length, includedRows, exclusions, lifecycleExclusionsKnown: true,
    observedSourceRows: unavailable ? null : active.length, unresolvedSourceRows: unavailable ? null : unresolved,
    matchedSourceRows: unavailable ? null : active.filter(row => row.status === "matched").length,
    rejectedSourceRows: unavailable ? null : active.filter(row => row.status === "rejected").length,
    undoneSourceRows: unavailable ? null : relevant.length - active.length,
    unknownSourceScopeRows: unavailable ? null : unknownScope,
    unobservedWorkspaceSourceRows: unavailable ? null : unobservedWorkspaceRows,
    knownAcceptedAccountIds: [...new Set(rows.flatMap(row => row.account_id ? [row.account_id] : []))].sort(),
    knownAcceptedCurrencies: [...new Set(rows.map(row => row.currency_code))].sort(),
    observedPostingRange: dates.length ? { from: dates[0], to: dates.at(-1)! } : null,
    importStatuses: unavailable ? null : states, importStatusScope: "workspace; period/account relevance can be unknown",
    statementIntervals: null, reconciledThrough: null, financialCompleteness: "unknown" as const,
    limitations, totalsAreBounds: false as const };
}

export type SourceCoverage = ReturnType<typeof buildSourceCoverage>;

export async function loadSourceCoverage(db: SupabaseClient, workspaceId: string, scope: CoverageScope,
  rows: EffectiveRow[], canReadImports: boolean): Promise<SourceCoverage> {
  if (!canReadImports) return buildSourceCoverage(scope, rows);
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
    all<SourceRow>("source_transactions", "import_id, status, posted_on:normalized_row->row->>postedOn, currency_code:normalized_row->row->>currencyCode, account_id:normalized_row->>accountId"),
  ]);
  return buildSourceCoverage(scope, rows, imports, sources);
}
