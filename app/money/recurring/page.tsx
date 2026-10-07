import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { detectRecurring } from "@/lib/finance/recurring";
import { confirmSeries, declineSeries } from "./actions";
import { confidenceToPercent, formatMoney as formatCurrency, seriesKey } from "./series";
import { OccurrenceReview } from "./occurrences";

const MAX_TRANSACTIONS = 10_000;
const PAGE_SIZE = 1000;

type TxRow = {
  id: string;
  posted_on: string;
  description: string;
  amount_minor: string;
  currency_code: string;
  account_id: string;
  merchant_id: string | null;
  version: number;
};

export default async function RecurringPage() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    redirect("/login");
  }
  const { supabase, workspace } = context;
  const formatMoney=(amount:string|bigint,currency:string)=>formatCurrency(amount,currency,workspace.locale);

  const [{ data: accounts, error: accountsError }, { data: stored, error: storedError }] = await Promise.all([
    supabase.from("accounts").select("id, name, currency_code").eq("workspace_id", workspace.id).order("name"),
    supabase.from("recurring_series")
      .select("id, account_id, normalized_label, cadence, currency_code, status, assumption_id, label, evidence_invalidated, evidence_baseline")
      .eq("workspace_id", workspace.id),
  ]);

  const rows: TxRow[] = [];
  let queryError: string | null = null;
  // Keyset pages preserve chronological selection even when other rows are inserted.
  // They are not a transaction snapshot: decisions validate owned evidence versions again.
  let cursor: TxRow | undefined;
  while (rows.length <= MAX_TRANSACTIONS) {
    let query = supabase.from("transactions")
      .select("id, posted_on, description, amount_minor::text, currency_code, account_id, merchant_id, version")
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
  const truncated = rows.length > MAX_TRANSACTIONS;
  const cutoff = truncated ? rows[MAX_TRANSACTIONS].posted_on : null;
  // Exclude the entire boundary date rather than presenting an arbitrary slice of that day's postings.
  if (cutoff) rows.splice(0, rows.length, ...rows.filter(row => row.posted_on > cutoff));
  const observedFrom = rows.at(-1)?.posted_on;
  const observedTo = rows[0]?.posted_on;

  let detected: ReturnType<typeof detectRecurring> = [];
  let detectError: string | null = null;
  if (!queryError) {
    try {
      detected = detectRecurring(rows.map((row) => ({
        id: row.id,
        date: row.posted_on,
        description: row.description,
        amountMinor: BigInt(row.amount_minor),
        currencyCode: row.currency_code,
        accountId: row.account_id,
        merchantId: row.merchant_id,
      })));
    } catch (error) {
      detectError = error instanceof Error ? error.message : String(error);
    }
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const names = Object.fromEntries((accounts ?? []).map((account) => [account.id, account.name]));
  const storedByKey = new Map(
    (stored ?? []).map((item) => [
      [item.account_id, item.currency_code, item.cadence, item.normalized_label].join("\0"),
      item,
    ]),
  );

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 px-4 py-6 text-foreground sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand">
            Money / Recurring
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Recurring review</h1>
        </div>
        <Link href="/money/transactions" className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium hover:bg-muted">Back to transactions</Link>
      </header>

      <p className="max-w-3xl text-sm text-muted-foreground">
        Estimated patterns inferred from the most recent complete posting dates, up to {MAX_TRANSACTIONS.toLocaleString(workspace.locale)} eligible posted transactions.
        Nothing here affects your forecast until you confirm it. Confirming creates one confirmed
        financial assumption used by the deterministic forecast; declining disables it.
      </p>

      {(stored??[]).some(series=>series.evidence_invalidated) && <section aria-label="Recurring source changes" className="rounded-lg border border-amber-500 p-4"><h2 className="font-medium">Confirmed source evidence changed</h2><p className="mt-2 text-sm">Inferred assumptions are disabled when their transaction evidence is reclassified. Intentional user assumptions are retained. Undo the source correction to restore unchanged inference, or review a new valid pattern before confirming it.</p><ul className="mt-3 space-y-3">{(stored??[]).filter(series=>series.evidence_invalidated).map(series=><li key={series.id} className="text-sm"><p>{series.label} · {names[series.account_id]??"Account"}</p><div className="flex flex-wrap gap-3">{((series.evidence_baseline??[]) as {id:string;posted_on:string}[]).map(source=><Link key={source.id} href={`/money/transactions?transaction=${source.id}`} className="underline">Source {source.posted_on}</Link>)}<Link href="/plan" className="underline">Review assumption in Plan</Link></div></li>)}</ul></section>}
      {accountsError && <p role="alert" className="mt-6">Could not load accounts: {accountsError.message}</p>}
      {storedError && <p role="alert" className="mt-6">Could not load review state: {storedError.message}</p>}
      {queryError && <p role="alert" className="mt-6">Could not load transactions: {queryError}</p>}
      {detectError && <p role="alert" className="mt-6">Could not detect patterns: {detectError}</p>}
      <p className="text-sm text-muted-foreground">{observedFrom ? `Observed eligible posting range: ${observedFrom} to ${observedTo}. ` : "No eligible posting dates loaded. "}Statement intervals, missing statements and account completeness are unknown. Pending, transfers and unresolved classifications are excluded. Three observations are required, so annual patterns need at least two years of retained history. Reads are paged; confirmation rechecks current source versions.</p>
      {truncated && <p className="mt-6 text-sm text-muted-foreground">History limit reached. All postings on or before {cutoff} were excluded to retain complete posting dates. Older patterns may be absent.</p>}

      {!queryError && !detectError && detected.length === 0 && (
        <p className="rounded-xl border border-border bg-card p-8 text-sm text-muted-foreground">No estimated recurring patterns found. Import more history to improve detection.</p>
      )}

      <OccurrenceReview supabase={supabase} workspace={workspace} accountNames={names} />
      <div className="grid gap-4 lg:grid-cols-2">
        {detected.map((series) => {
          const key = seriesKey({
            accountId: series.accountId,
            currencyCode: series.currencyCode,
            cadence: series.cadence,
            label: series.label,
          });
          const state = storedByKey.get(key);
          const status = state?.status ?? "pending";
          const percent = confidenceToPercent(series.confidence);
          const evidence = series.transactionIds.map((id) => byId.get(id)).filter((row): row is TxRow => Boolean(row));
          return (
            <article key={key} className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">{series.label}</h2>
                <span className="rounded bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700">Estimated · {series.cadence}</span>
                {status === "confirmed" && <span className="rounded bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">Confirmed · used in forecast</span>}
                {status === "dismissed" && <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">Dismissed · not recurring</span>}
              </div>
              <p className="mt-3 font-mono text-sm">
                {formatMoney(series.amountMinMinor.toString(), series.currencyCode)}
                {series.amountMinMinor !== series.amountMaxMinor && <> to {formatMoney(series.amountMaxMinor.toString(), series.currencyCode)}</>}
                {" · "}{names[series.accountId] ?? "Unknown account"}
                {" · "}{series.occurrences} payments · confidence {percent}%
              </p>
              <p className="mt-2 text-xs text-muted-foreground">{series.amountMinMinor === series.amountMaxMinor ? "Amounts agree exactly." : "Amounts vary within the 15% grouping limit."} {series.missingPeriods} unobserved expected periods between evidence dates; these are not known missed payments. Up to two unobserved periods per gap are allowed. Regular discretionary purchases can also match; this heuristic is not a probability. Review the evidence before confirming.</p>
              <details className="mt-4 border-t border-border pt-3 text-xs">
                <summary className="cursor-pointer underline">Evidence ({evidence.length} posted transactions)</summary>
                <ul className="mt-2 space-y-1">
                  {evidence.slice(0, 8).map((row) => (
                    <li key={row.id} className="text-muted-foreground">
                      {row.posted_on} · {formatMoney(row.amount_minor, row.currency_code)} · {row.description}
                    </li>
                  ))}
                </ul>
                {evidence.length > 8 && <p className="mt-1 text-muted-foreground">…and {evidence.length - 8} more.</p>}
              </details>
              <div className="mt-4 flex flex-wrap gap-3">
                <form action={confirmSeries}>
                  <input type="hidden" name="accountId" value={series.accountId} />
                  <input type="hidden" name="label" value={series.label} />
                  <input type="hidden" name="cadence" value={series.cadence} />
                  <input type="hidden" name="currencyCode" value={series.currencyCode} />
                  <input type="hidden" name="amountMinMinor" value={series.amountMinMinor.toString()} />
                  <input type="hidden" name="amountMaxMinor" value={series.amountMaxMinor.toString()} />
                  <input type="hidden" name="occurrences" value={series.occurrences} />
                  <input type="hidden" name="confidence" value={percent} />
                  <input type="hidden" name="transactionIds" value={series.transactionIds.join(",")} />
                  <button className="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90">Confirm</button>
                </form>
                <form action={declineSeries}>
                  <input type="hidden" name="accountId" value={series.accountId} />
                  <input type="hidden" name="label" value={series.label} />
                  <input type="hidden" name="cadence" value={series.cadence} />
                  <input type="hidden" name="currencyCode" value={series.currencyCode} />
                  <input type="hidden" name="amountMinMinor" value={series.amountMinMinor.toString()} />
                  <input type="hidden" name="amountMaxMinor" value={series.amountMaxMinor.toString()} />
                  <input type="hidden" name="occurrences" value={series.occurrences} />
                  <input type="hidden" name="confidence" value={percent} />
                  <input type="hidden" name="transactionIds" value={series.transactionIds.join(",")} />
                  <button className="rounded-lg border border-border px-4 py-2 text-xs font-medium hover:bg-muted">Not recurring</button>
                </form>
              </div>
            </article>
          );
        })}
      </div>
    </main>
  );
}
