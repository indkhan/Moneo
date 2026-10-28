import type { SupabaseClient } from "@supabase/supabase-js";
import { detectRecurring, type RecurringSeries } from "@/lib/finance/recurring";

export const MAX_TRANSACTIONS = 10_000;
const PAGE_SIZE = 1000;

export type TxRow = {
  id: string; posted_on: string; description: string; amount_minor: string; currency_code: string; account_id: string;
  merchant_id: string | null; version: number; status: "posted"; kind: "ordinary"; review_reasons: string[];
};
type Stored = { id: string; account_id: string; currency_code: string; cadence: string; status: string; label?: string; evidence_invalidated?: boolean; evidence_baseline?: unknown;
  recurring_series_transactions?: { transaction_id: string }[]; assumption?: { source: string; confirmed: boolean; enabled: boolean; removed_at: string | null } | { source: string; confirmed: boolean; enabled: boolean; removed_at: string | null }[] | null };

/** Detected recurring patterns with their review state. Reads up to 10k postings in serial keyset pages; shared by the Recurring page and chat. */
export async function loadSuggestions(supabase: SupabaseClient, workspace: { id: string }) {
  // Started now (builders are lazy thenables) so it runs while transactions page in.
  const storedQuery = Promise.resolve(supabase.from("recurring_series")
    .select("id, account_id, normalized_label, cadence, currency_code, status, assumption_id, label, evidence_invalidated, evidence_baseline, recurring_series_transactions(transaction_id), assumption:financial_assumptions(source,confirmed,enabled,removed_at)")
    .eq("workspace_id", workspace.id));

  const rows: TxRow[] = [];
  let queryError: string | null = null;
  // Keyset pages preserve chronological selection even when other rows are inserted.
  // They are not a transaction snapshot: decisions validate owned evidence versions again.
  let cursor: TxRow | undefined;
  while (rows.length <= MAX_TRANSACTIONS) {
    let query = supabase.from("transactions")
      .select("id, posted_on, description, amount_minor::text, currency_code, account_id, merchant_id, version, status, kind, review_reasons")
      .eq("workspace_id", workspace.id)
      .eq("status", "posted")
      .eq("kind", "ordinary").eq("review_reasons", "{}")
      .order("posted_on", { ascending: false }).order("id", { ascending: false });
    if (cursor) query = query.or(`posted_on.lt.${cursor.posted_on},and(posted_on.eq.${cursor.posted_on},id.lt.${cursor.id})`);
    const size = Math.min(PAGE_SIZE, MAX_TRANSACTIONS + 1 - rows.length);
    const { data, error } = await query.range(0, size - 1);
    if (error) { queryError = error.message; break; }
    const page = (data ?? []) as TxRow[];
    rows.push(...page);
    if (page.length < size) break;
    cursor = page.at(-1);
  }
  const { data: storedData, error: storedError } = await storedQuery;
  const stored = (storedData ?? []) as Stored[];
  const truncated = rows.length > MAX_TRANSACTIONS;
  const cutoff = truncated ? rows[MAX_TRANSACTIONS].posted_on : null;
  // Exclude the entire boundary date rather than presenting an arbitrary slice of that day's postings.
  if (cutoff) rows.splice(0, rows.length, ...rows.filter(row => row.posted_on > cutoff));
  const observedFrom = rows.at(-1)?.posted_on;
  const observedTo = rows[0]?.posted_on;

  let detected: RecurringSeries[] = [];
  let detectError: string | null = null;
  if (!queryError) {
    try {
      detected = detectRecurring(rows.map(row => ({ id: row.id, date: row.posted_on, description: row.description, amountMinor: BigInt(row.amount_minor),
        currencyCode: row.currency_code, accountId: row.account_id, merchantId: row.merchant_id })));
    } catch (error) {
      detectError = error instanceof Error ? error.message : String(error);
    }
  }
  const byId = new Map(rows.map(row => [row.id, row]));
  const candidates = detected.map(series => {
    const related = stored.filter(item => item.account_id === series.accountId && item.currency_code === series.currencyCode && item.cadence === series.cadence &&
      item.recurring_series_transactions?.some(link => series.transactionIds.includes(link.transaction_id)));
    const state = related.length === 1 ? related[0] : undefined;
    return { series, related, status: state?.status ?? "pending", assumption: Array.isArray(state?.assumption) ? state.assumption[0] : state?.assumption,
      evidence: series.transactionIds.map(id => byId.get(id)).filter((row): row is TxRow => Boolean(row)) };
  });
  const pending = candidates.filter(item => item.status === "pending"), reviewed = candidates.filter(item => item.status !== "pending");
  const invalidated = stored.filter(series => series.evidence_invalidated);

  return { candidates, pending, reviewed, invalidated, truncated, cutoff, observedFrom, observedTo, detected, queryError, storedError: storedError?.message ?? null, detectError };
}

export type Suggestion = Awaited<ReturnType<typeof loadSuggestions>>["candidates"][number];

/** The compact evidence a confirm or dismiss needs; the database re-checks every version under lock. */
export function seriesDecision({ series, evidence }: Pick<Suggestion, "series" | "evidence">) {
  return { accountId: series.accountId, label: series.label, cadence: series.cadence, currencyCode: series.currencyCode,
    evidence: evidence.map(row => ({ id: row.id, version: row.version })), runAnchorId: series.runAnchorId, evidenceLimited: series.evidenceLimited };
}
