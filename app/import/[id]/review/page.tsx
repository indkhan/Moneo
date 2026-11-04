import Link from "next/link";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { ClassificationActions, ReviewActions } from "./actions";
import { formatMoney } from "@/lib/finance/format";
import { mappingSchema, mapImportReviewRow, type SourceRow } from "@/lib/import/csv";
import { PendingSettlement } from "./pending-settlement";

export const metadata = { title: "Review import" };

// Original source evidence as a compact field list; internal parser columns stay hidden.
function SourceFields({ row }: { row: SourceRow }) {
  return <dl className="grid gap-x-4 gap-y-1 rounded-lg bg-muted p-3 text-xs sm:grid-cols-[max-content_1fr]">{Object.entries(row ?? {}).filter(([column]) => !column.startsWith("__moneo_csv_")).map(([column, value]) =>
    <div key={column} className="contents"><dt className="font-medium text-muted-foreground">{column}</dt><dd className="break-all">{String(value) || "—"}</dd></div>)}</dl>;
}

const PAGE_SIZE = 100;

export default async function ImportReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { redirect("/login"); }
  const { id } = await params;
  const requestedFrom = Number((await searchParams).from);
  const from = Number.isSafeInteger(requestedFrom) && requestedFrom > 0 ? requestedFrom : 0;
  const { supabase, workspace } = context;
  const { data: imported } = await supabase.from("imports").select("id, filename, status, total_rows, new_rows, matched_rows, rejected_rows, route_accounts, mapping, review_rows, classification_review_rows")
    .eq("workspace_id", workspace.id).eq("id", id).maybeSingle();
  if (!imported) notFound();
  const interpretation = mappingSchema.safeParse(imported.mapping);
  const decisions = interpretation.success ? interpretation.data.rowDecisions ?? [] : [];
  const [decisionRows, { data: rows, error }, destinations, classifications, reviewHistory] = await Promise.all([
    decisions.length ? supabase.from("source_transactions").select("id, row_number, original_row, status")
      .eq("workspace_id", workspace.id).eq("import_id", id).in("row_number", decisions.map(row => row.rowNumber)).order("row_number").limit(100) : null,
    supabase.from("source_transactions")
      .select("id, row_number, original_row, external_id, normalized_row")
      .eq("workspace_id", workspace.id).eq("import_id", id).eq("status", "review")
      .order("row_number").range(from, from + PAGE_SIZE - 1),
    supabase.from("accounts").select("id, name, currency_code, version, archived_at")
      .eq("workspace_id", workspace.id).order("name").limit(1000),
    supabase.from("transactions")
      .select("id, description, amount_minor::text, currency_code, version, review_reasons, transaction_sources!inner(source_transactions!inner(import_id, row_number, original_row))")
      .eq("workspace_id", workspace.id).eq("transaction_sources.source_transactions.import_id", id)
      .not("review_reasons", "eq", "{}").order("id").limit(100),
    supabase.from("correction_events")
      .select("id, transaction_id, undone, created_at, transactions!inner(version, transaction_sources!inner(source_transactions!inner(import_id)))")
      .eq("workspace_id", workspace.id).eq("transactions.transaction_sources.source_transactions.import_id", id)
      .contains("after", { operation: "classification_review" }).order("created_at", { ascending: false }).limit(20),
  ]);

  return <main className="mx-auto w-full max-w-[1400px] space-y-8 px-4 py-6 sm:px-8 lg:py-8">
    <Link href="/import" className="text-sm underline">← Import history</Link>
    <div><p className="eyebrow">Money · Import review</p><h1 className="mt-2 page-title">Review: {imported.filename}</h1><p className="mt-2 text-sm text-muted-foreground">{imported.review_rows} unclear rows are left out of your totals until you decide.</p></div>
    {error && <p role="alert" className="text-sm text-danger">Could not load review rows: {error.message}</p>}
    {!error && !rows?.length && <p className="text-sm text-muted-foreground">No rows awaiting review.</p>}
    {rows?.map((row) => {
      const normalized = row.normalized_row as { accountId?: string | null; row?: { currencyCode: string; status: string } } | null;
      let currency = normalized?.row?.currencyCode;
      let interpreted: { postedOn: string; description: string; amountMinor: bigint | string; currencyCode: string } | null = (normalized?.row as never) ?? null;
      let frozenId = normalized?.accountId ?? null;
      if (!normalized) try {
        const mapped = mapImportReviewRow(row.original_row as SourceRow, row.row_number, imported.mapping);
        currency = mapped.currencyCode;
        interpreted = mapped;
        frozenId = Object.entries(imported.route_accounts ?? {}).find(([key]) => {
          const route = JSON.parse(key);
          return route[0] === mapped.accountName && route[1] === mapped.currencyCode;
        })?.[1] as string ?? null;
      } catch { /* The server reports unavailable legacy interpretation on acceptance. */ }
      const frozen = destinations.data?.find(account => account.id === frozenId);
      return <article className="space-y-4 rounded-xl border border-border bg-card p-6" key={row.id}>
      <h2 className="text-sm font-medium">Source row {row.row_number}</h2>
      {interpreted ? <p className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><span className="min-w-0 break-words"><span className="font-medium">{interpreted.description}</span> <span className="font-mono text-xs text-muted-foreground">{interpreted.postedOn}</span></span><span className="font-mono font-medium tabular-nums">{formatMoney(BigInt(interpreted.amountMinor), interpreted.currencyCode, workspace.locale)}</span></p>
        : <p role="alert" className="text-sm">Moneo could not read this row. Check the original below before deciding.</p>}
      <p className="text-sm text-muted-foreground">Held back because it may overlap something you already have. It is not in your totals yet.</p>
      <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Original row{row.external_id ? ` · source ID ${row.external_id}` : ""}</summary><div className="mt-2"><SourceFields row={row.original_row as SourceRow} /></div></details>
      {imported.status === "completed" && row.external_id && frozenId && currency && normalized?.row?.status === "posted" &&
        <Suspense fallback={<p className="text-sm text-muted-foreground">Checking for matching pending payments…</p>}><PendingSettlement importId={id} sourceId={row.id} externalId={row.external_id} accountId={frozenId} currency={currency} /></Suspense>}
      {imported.status === "completed" && <ReviewActions importId={id} sourceId={row.id} frozenId={frozenId} frozenName={frozen?.name}
        unavailable={!frozen || !!frozen.archived_at || frozen.currency_code !== currency}
        destinations={destinations.error ? [] : (destinations.data ?? []).filter(account => !account.archived_at && account.currency_code === currency)} />}
    </article>; })}
    {(from > 0 || rows?.length === PAGE_SIZE) && <nav aria-label="Review rows" className="flex flex-wrap items-center gap-4 text-sm">
      <span className="text-muted-foreground">Rows {from + 1} to {from + (rows?.length ?? 0)} of the {imported.review_rows} to review</span>
      {from > 0 && <Link className="underline" href={`/import/${id}/review?from=${Math.max(0, from - PAGE_SIZE)}`}>Previous {PAGE_SIZE}</Link>}
      {rows?.length === PAGE_SIZE && <Link className="underline" href={`/import/${id}/review?from=${from + PAGE_SIZE}`}>Next {PAGE_SIZE}</Link>}
    </nav>}
    <section className="space-y-4" aria-label="Source coverage and reviewed interpretation">
      <h2 className="text-sm font-medium">Source coverage</h2>
      <p className="text-sm text-muted-foreground">{imported.new_rows + imported.matched_rows} accepted · {imported.rejected_rows} excluded · {imported.review_rows} unresolved · {imported.total_rows} original observations</p>
      {decisionRows?.error && <p role="alert" className="text-sm text-danger">Could not load reviewed source evidence.</p>}
      {decisionRows?.data?.map(row => {
        const decision = decisions.find(item => item.rowNumber === row.row_number)!;
        return <article key={row.id} className="space-y-3 rounded-lg border border-border p-4 text-sm"><h3 className="font-medium capitalize">Source row {row.row_number} · {decision.action === "exclude" ? "Excluded" : "Corrected"} · {row.status.replaceAll("_", " ")}</h3>
          {decision.action === "exclude" ? <p>{decision.reason}</p> : <dl>{Object.entries(decision.values).map(([column, value]) => <div key={column}><dt className="font-medium">{column}</dt><dd>{value}</dd></div>)}</dl>}
          <details><summary className="cursor-pointer">Original row</summary><div className="mt-2"><SourceFields row={row.original_row as SourceRow} /></div></details>
        </article>;
      })}
      {decisionRows?.data?.length === 100 && <p className="text-sm text-muted-foreground">Showing the first 100 reviewed source observations.</p>}
    </section>
    <section className="space-y-4" aria-label="Financial classification review">
      <h2 className="text-sm font-medium">Transaction type</h2>
      <p className="text-sm text-muted-foreground">{imported.classification_review_rows} rows still need a type: ordinary, refund or transfer between your accounts. Their amounts are already in your balances, but income and spending totals are incomplete until you review them.</p>
      {classifications.error && <p role="alert" className="text-sm text-danger">Could not load classifications: {classifications.error.message}</p>}
      {classifications.data?.map(transaction => <article className="space-y-3 rounded-xl border border-border bg-card p-6" key={transaction.id}>
        <h3 className="text-base font-semibold">{transaction.description} · {formatMoney(transaction.amount_minor, transaction.currency_code)}</h3>
        <p className="text-sm text-muted-foreground">Needs review: {transaction.review_reasons.map((reason: string) => reason.replaceAll("_", " ")).join(", ")}</p>
        <details className="text-sm"><summary className="cursor-pointer">Original row</summary><div className="mt-2 space-y-2">{(transaction.transaction_sources as unknown as { source_transactions: { row_number: number; original_row: SourceRow } }[]).map(link => <SourceFields key={link.source_transactions.row_number} row={link.source_transactions.original_row} />)}</div></details>
        <ClassificationActions importId={id} transactionId={transaction.id} version={transaction.version} reasons={transaction.review_reasons} />
      </article>)}
      {classifications.data?.length === 100 && <p className="text-sm text-muted-foreground">Showing the first 100 unresolved transactions. More appear as these are reviewed.</p>}
    </section>
    <section className="space-y-4" aria-label="Classification history"><h2 className="text-sm font-medium">Recent classification history</h2>
      {reviewHistory.error && <p role="alert" className="text-sm text-danger">Could not load review history.</p>}
      {reviewHistory.data?.map(event => {
        const transaction = event.transactions as unknown as { version: number };
        return <article className="space-y-3 rounded-lg border border-border p-4 text-sm" key={event.id}><p>Reviewed {new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}{event.undone ? " · undone" : ""}</p>
          {!event.undone && <ClassificationActions importId={id} transactionId={event.transaction_id} version={transaction.version} eventId={event.id} />}
        </article>;
      })}
    </section>
  </main>;
}
