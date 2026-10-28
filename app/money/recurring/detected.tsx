import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expandSchedule } from "@/lib/finance/model";
import { formatInputAmount } from "@/lib/finance/format";
import { confirmSeries, declineSeries } from "./actions";
import { ActionForm, ScheduleDialog } from "./forms";
import { formatMoney as formatCurrency, seriesKey } from "./series";
import { loadSuggestions, MAX_TRANSACTIONS, seriesDecision, type Suggestion } from "./suggestions";

// Detection reads up to 10k postings in serial keyset pages, so the page streams this section.
export async function DetectedPatterns({ supabase, workspace, names, today, categories }: { supabase: SupabaseClient; workspace: { id: string; locale: string }; names: Record<string, string>; today: string; categories: string[] }) {
  const formatMoney = (amount: string | bigint, currency: string) => formatCurrency(amount, currency, workspace.locale);
  const { pending, reviewed, invalidated, truncated, cutoff, observedFrom, observedTo, detected, queryError, storedError, detectError } = await loadSuggestions(supabase, workspace);

  const card = ({ series, related, status, assumption, evidence }: Suggestion) => {
    const decision = seriesDecision({ series, evidence });
    const hidden = { accountId: decision.accountId, label: decision.label, cadence: decision.cadence, currencyCode: decision.currencyCode,
      sourceEvidence: JSON.stringify(decision.evidence), runAnchorId: decision.runAnchorId, evidenceLimited: String(decision.evidenceLimited) };
    // Prefill the latest amount and the next date this pattern is expected, so confirming is usually one click.
    const latest = evidence.at(-1);
    const amount = BigInt(latest?.amount_minor ?? series.amountMaxMinor);
    const next = latest ? expandSchedule({ account_id: series.accountId, amount_minor: amount.toString(), currency_code: series.currencyCode, cadence: series.cadence,
      starts_on: latest.posted_on, ends_on: null, schedule_anchor_on: series.anchorDate }, today, 400)[0]?.date : undefined;
    const blocked = related.length > 1;
    return <article key={seriesKey(series)} className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{series.label}</h3>
        <span className="rounded bg-muted px-2 py-0.5 text-xs capitalize">{series.cadence}</span>
        {status === "confirmed" && <span className="rounded bg-success-soft px-2 py-0.5 text-xs text-success">Confirmed{assumption?.confirmed && assumption.enabled && !assumption.removed_at ? " · used in forecast" : " · review schedule in Plan"}</span>}
        {status === "dismissed" && <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">Dismissed</span>}
        <span className="font-mono text-sm tabular-nums">{formatMoney(series.amountMinMinor, series.currencyCode)}{series.amountMinMinor !== series.amountMaxMinor && <> to {formatMoney(series.amountMaxMinor, series.currencyCode)}</>}</span>
        <div className="flex gap-2">
          {status !== "confirmed" && !blocked && <ScheduleDialog title={`Confirm ${series.label}`} trigger="Confirm" submitLabel="Confirm recurring" action={confirmSeries} hidden={hidden} categories={categories}
            triggerClassName="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            defaults={{ name: series.label, amount: formatInputAmount(amount < 0n ? -amount : amount, series.currencyCode), direction: amount < 0n ? "out" : "in", cadence: series.cadence, startsOn: next ?? today, category: "", currencyCode: series.currencyCode }} />}
          {status !== "dismissed" && !blocked && <ActionForm action={declineSeries} hidden={hidden} className="flex flex-col gap-1"><button className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted">Not recurring</button></ActionForm>}
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
    {storedError && <p role="alert">Could not load review state: {storedError}</p>}
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
