import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectRecurring, type RecurringSeries } from "@/lib/finance/recurring";
import { confirmSeries, declineSeries } from "./actions";
import { formatMoney as formatCurrency, seriesKey } from "./series";

const MAX_TRANSACTIONS = 10_000;
const PAGE_SIZE = 1000;

type TxRow = {
  id: string; posted_on: string; description: string; amount_minor: string; currency_code: string; account_id: string;
  merchant_id: string | null; version: number; status: "posted"; kind: "ordinary"; review_reasons: string[];
};
type Stored = { id: string; account_id: string; currency_code: string; cadence: string; status: string; label?: string; evidence_invalidated?: boolean; evidence_baseline?: unknown;
  recurring_series_transactions?: { transaction_id: string }[]; assumption?: { source: string; confirmed: boolean; enabled: boolean; removed_at: string | null } | { source: string; confirmed: boolean; enabled: boolean; removed_at: string | null }[] | null };

// Detection reads up to 10k postings in serial keyset pages, so the page streams this section.
export async function DetectedPatterns({ supabase, workspace, names }: { supabase: SupabaseClient; workspace: { id: string; locale: string }; names: Record<string, string> }) {
  const formatMoney = (amount: string | bigint, currency: string) => formatCurrency(amount, currency, workspace.locale);
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

  const card = ({ series, related, status, assumption, evidence }: typeof candidates[number]) => {
    const hidden = <>
      <input type="hidden" name="accountId" value={series.accountId} />
      <input type="hidden" name="label" value={series.label} />
      <input type="hidden" name="cadence" value={series.cadence} />
      <input type="hidden" name="currencyCode" value={series.currencyCode} />
      <input type="hidden" name="sourceEvidence" value={JSON.stringify(evidence.map(row => ({ id: row.id, version: row.version })))} />
      <input type="hidden" name="runAnchorId" value={series.runAnchorId} />
      <input type="hidden" name="evidenceLimited" value={String(series.evidenceLimited)} />
    </>;
    const blocked = related.length > 1;
    return <article key={seriesKey(series)} className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{series.label}</h3>
        <span className="rounded bg-muted px-2 py-0.5 text-xs capitalize">{series.cadence}</span>
        {status === "confirmed" && <span className="rounded bg-success-soft px-2 py-0.5 text-xs text-success">Confirmed{assumption?.confirmed && assumption.enabled && !assumption.removed_at ? " · used in forecast" : " · review schedule in Plan"}</span>}
        {status === "dismissed" && <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">Dismissed</span>}
        <span className="font-mono text-sm tabular-nums">{formatMoney(series.amountMinMinor, series.currencyCode)}{series.amountMinMinor !== series.amountMaxMinor && <> to {formatMoney(series.amountMaxMinor, series.currencyCode)}</>}</span>
        <div className="flex gap-2">
          {status !== "confirmed" && <form action={confirmSeries}>{hidden}<button disabled={blocked} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Confirm</button></form>}
          {status !== "dismissed" && <form action={declineSeries}>{hidden}<button disabled={blocked} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50">Not recurring</button></form>}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{names[series.accountId] ?? "Unknown account"} · {series.occurrences} observed payments (a count, not a probability)</p>
      {blocked && <p role="alert" className="mt-1 text-xs">Evidence overlaps several reviewed runs. Review their schedules in Plan before deciding.</p>}
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Evidence ({evidence.length} posted transactions)</summary>
        {(series.evidenceLimited || series.sameDateAlternatives > 0) && <p className="mt-1 text-muted-foreground">{series.evidenceLimited && `Review evidence retains the original calendar anchor and the latest 999 of ${series.observedOccurrences} matching observations. `}{series.sameDateAlternatives > 0 && `${series.sameDateAlternatives} other similar same-date postings were not selected. They may represent separate purchases or obligations; review them before confirming.`}</p>}
        {assumption?.source === "user" && <p className="mt-1 text-muted-foreground">Your intentional Plan schedule is retained when confirming or declining this candidate. Edit or disable it in <Link href="/plan" className="underline">Plan</Link>.</p>}
        <ul className="mt-1 space-y-0.5 text-muted-foreground">{evidence.slice(0, 8).map(row => <li key={row.id}>
          <Link className="hover:underline" href={`/money/transactions?transaction=${row.id}`}>{row.posted_on} · {formatMoney(row.amount_minor, row.currency_code)} · {row.description}</Link></li>)}</ul>
        {evidence.length > 8 && <p className="mt-1 text-muted-foreground">…and {evidence.length - 8} more.</p>}
      </details>
    </article>;
  };

  return <>
    {invalidated.length > 0 && <section aria-label="Recurring source changes" className="rounded-xl border border-warning/40 p-5"><h2 className="text-sm font-medium">Confirmed source evidence changed</h2><p className="mt-2 text-sm">Inferred assumptions are disabled when their transaction evidence is reclassified. Intentional user assumptions are retained. Undo the source correction to restore unchanged inference, or review a new valid pattern before confirming it.</p><ul className="mt-3 space-y-3">{invalidated.map(series => <li key={series.id} className="text-sm"><p>{series.label} · {names[series.account_id] ?? "Account"}</p><div className="flex flex-wrap gap-3">{((series.evidence_baseline ?? []) as { id: string; posted_on: string }[]).map(source => <Link key={source.id} href={`/money/transactions?transaction=${source.id}`} className="underline">Source {source.posted_on}</Link>)}<Link href="/plan" className="underline">Review assumption in Plan</Link></div></li>)}</ul></section>}
    {storedError && <p role="alert">Could not load review state: {storedError.message}</p>}
    {queryError && <p role="alert">Could not load transactions: {queryError}</p>}
    {detectError && <p role="alert">Could not detect patterns: {detectError}</p>}

    <section aria-label="Detected patterns" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Suggestions {pending.length ? <span className="text-muted-foreground">({pending.length})</span> : null}</h2>
        <p className="text-xs text-muted-foreground">{observedFrom ? `Based on posted transactions from ${observedFrom} to ${observedTo}.` : "No posted transactions to analyze yet."}</p>
      </div>
      {truncated && <p className="text-xs text-muted-foreground">History limit reached. All postings on or before {cutoff} were excluded to retain complete posting dates. Older patterns may be absent.</p>}
      {!queryError && !detectError && !pending.length && <p className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">{detected.length ? "All detected patterns are reviewed." : "No recurring payments found yet. Import more history to improve detection."}</p>}
      {pending.map(card)}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer hover:text-foreground">How detection works</summary><p className="mt-2">Looks at up to {MAX_TRANSACTIONS.toLocaleString(workspace.locale)} recent posted transactions. Statement intervals, missing statements and account completeness are unknown. Pending items, transfers and unresolved classifications are excluded. A pattern needs at least three payments, so yearly ones need two years of history. Confirming creates one forecast assumption; schedules you edited in Plan are kept. Regular purchases can look like this too, so check the evidence before confirming.</p></details>
    </section>

    {reviewed.length > 0 && <section aria-label="Reviewed patterns" className="space-y-3">
      <h2 className="text-sm font-medium">Reviewed <span className="text-muted-foreground">({reviewed.length})</span></h2>
      {reviewed.map(card)}
    </section>}
  </>;
}
