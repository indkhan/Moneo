import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { ClassificationActions, ReviewActions } from "./actions";
import { formatMoney } from "@/lib/finance/format";

export default async function ImportReviewPage({ params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { redirect("/login"); }
  const { id } = await params;
  const { supabase, workspace } = context;
  const { data: imported } = await supabase.from("imports").select("id, filename, status, review_rows, classification_review_rows")
    .eq("workspace_id", workspace.id).eq("id", id).maybeSingle();
  if (!imported) notFound();
  const { data: rows, error } = await supabase.from("source_transactions")
    .select("id, row_number, original_row, external_id")
    .eq("workspace_id", workspace.id).eq("import_id", id).eq("status", "review")
    .order("row_number").limit(100);
  const classifications = await supabase.from("transactions")
    .select("id, description, amount_minor::text, currency_code, version, review_reasons, transaction_sources!inner(source_transactions!inner(import_id, row_number, original_row))")
    .eq("workspace_id", workspace.id).eq("transaction_sources.source_transactions.import_id", id)
    .not("review_reasons", "eq", "{}").order("id").limit(100);
  const reviewHistory = await supabase.from("correction_events")
    .select("id, transaction_id, undone, created_at, transactions!inner(version, transaction_sources!inner(source_transactions!inner(import_id)))")
    .eq("workspace_id", workspace.id).eq("transactions.transaction_sources.source_transactions.import_id", id)
    .contains("after", { operation: "classification_review" }).order("created_at", { ascending: false }).limit(20);

  return <main className="mx-auto max-w-5xl space-y-5 px-5 py-8 lg:px-8">
    <Link href="/import" className="underline">← Import history</Link>
    <div><p className="text-xs font-semibold uppercase tracking-widest text-brand">Money / Import review</p><h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Review: {imported.filename}</h1><p className="mt-2 text-sm text-muted-foreground">{imported.review_rows} ambiguous rows. They are excluded from accepted totals.</p></div>
    {error && <p role="alert">Could not load review rows: {error.message}</p>}
    {!error && !rows?.length && <p>No rows awaiting review.</p>}
    {rows?.map((row) => <article className="rounded-xl border border-border bg-card p-5 shadow-sm" key={row.id}>
      <h2 className="font-medium">Source row {row.row_number}</h2>
      {row.external_id && <p className="text-sm">Source ID: {row.external_id}</p>}
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 text-sm">{JSON.stringify(row.original_row, null, 2)}</pre>
      {imported.status === "completed" && <ReviewActions importId={id} sourceId={row.id} />}
    </article>)}
    {rows?.length === 100 && <p>Showing the first 100 rows.</p>}
    <section className="space-y-4" aria-label="Financial classification review">
      <h2 className="text-xl font-semibold">Financial meaning</h2>
      <p>{imported.classification_review_rows} source rows await classification. Their booked amounts remain in account balances; income and spending are partial until reviewed.</p>
      {classifications.error && <p role="alert">Could not load classifications: {classifications.error.message}</p>}
      {classifications.data?.map(transaction => <article className="rounded-xl border border-border bg-card p-5" key={transaction.id}>
        <h3 className="font-medium">{transaction.description} · {formatMoney(transaction.amount_minor, transaction.currency_code)}</h3>
        <p className="mt-1 text-sm">Review reasons: {transaction.review_reasons.join(", ")}</p>
        <details className="mt-2 text-sm"><summary>Original source evidence</summary><pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3">{JSON.stringify(transaction.transaction_sources, null, 2)}</pre></details>
        <ClassificationActions importId={id} transactionId={transaction.id} version={transaction.version} reasons={transaction.review_reasons} />
      </article>)}
      {classifications.data?.length === 100 && <p>Showing the first 100 unresolved transactions. More appear as these are reviewed.</p>}
    </section>
    <section className="space-y-3" aria-label="Classification history"><h2 className="text-xl font-semibold">Recent classification history</h2>
      {reviewHistory.error && <p role="alert">Could not load review history.</p>}
      {reviewHistory.data?.map(event => {
        const transaction = event.transactions as unknown as { version: number };
        return <article className="rounded-lg border border-border p-3 text-sm" key={event.id}><p>Reviewed {new Date(event.created_at).toLocaleString()}{event.undone ? " · undone" : ""}</p>
          {!event.undone && <ClassificationActions importId={id} transactionId={event.transaction_id} version={transaction.version} eventId={event.id} />}
        </article>;
      })}
    </section>
  </main>;
}
