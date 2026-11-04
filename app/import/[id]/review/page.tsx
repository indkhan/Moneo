import Link from "next/link";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { ClassificationActions, ReviewActions, UndoRowDecision } from "./actions";
import { formatMoney } from "@/lib/finance/format";
import { mappingSchema, mapImportReviewRow, type SourceRow } from "@/lib/import/csv";
import { PendingSettlement } from "./pending-settlement";

export const metadata = { title: "Review import" };

// Original source evidence as a compact field list; internal parser columns stay hidden.
function SourceFields({ row }: { row: SourceRow }) {
  return <dl className="grid gap-x-4 gap-y-1 rounded-lg bg-muted p-3 text-xs sm:grid-cols-[max-content_1fr]">{Object.entries(row ?? {}).filter(([column]) => !column.startsWith("__moneo_csv_")).map(([column, value]) =>
    <div key={column} className="contents"><dt className="font-medium text-muted-foreground">{column}</dt><dd className="break-words [overflow-wrap:anywhere]">{String(value) || "—"}</dd></div>)}</dl>;
}

const PAGE_SIZE = 100;
const HISTORY_SIZE = 20;

export default async function ImportReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ after?: string; reviewedAfter?: string; decidedAfter?: string; typeAfter?: string; historyBefore?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { redirect("/login"); }
  const { id } = await params;
  // By row number, not offset: deciding rows shrinks the list, and an offset would then skip the ones left.
  const query = await searchParams;
  const rowCursor = (value?: string) => { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : 0; };
  const after = rowCursor(query.after), reviewedAfter = rowCursor(query.reviewedAfter), decidedAfter = rowCursor(query.decidedAfter);
  const typeAfter = z.uuid().safeParse(query.typeAfter).data;
  const historyBefore = z.iso.datetime({ offset: true }).safeParse(query.historyBefore).data;
  const { supabase, workspace } = context;
  const { data: imported } = await supabase.from("imports").select("id, filename, status, total_rows, new_rows, matched_rows, rejected_rows, route_accounts, mapping, review_rows, classification_review_rows")
    .eq("workspace_id", workspace.id).eq("id", id).maybeSingle();
  if (!imported) notFound();
  const interpretation = mappingSchema.safeParse(imported.mapping);
  const decisions = interpretation.success ? interpretation.data.rowDecisions ?? [] : [];
  const decidedQuery = supabase.from("source_transactions").select("id, row_number, status, original_row, normalized_row, transaction_sources(transaction_id)")
    .eq("workspace_id", workspace.id).eq("import_id", id).in("status", ["accepted", "rejected"]).gt("row_number", decidedAfter).order("row_number").limit(PAGE_SIZE);
  const typesQuery = supabase.from("transactions")
    .select("id, description, amount_minor::text, currency_code, version, review_reasons, transaction_sources!inner(source_transactions!inner(import_id, row_number, original_row))")
    .eq("workspace_id", workspace.id).eq("transaction_sources.source_transactions.import_id", id)
    .not("review_reasons", "eq", "{}");
  const historyQuery = supabase.from("correction_events")
    .select("id, transaction_id, undone, created_at, after, transactions!inner(version, description, amount_minor::text, currency_code, transaction_sources!inner(source_transactions!inner(import_id)))")
    .eq("workspace_id", workspace.id).eq("transactions.transaction_sources.source_transactions.import_id", id)
    .contains("after", { operation: "classification_review" });
  const [decisionRows, { data: rows, error }, destinations, classifications, reviewHistory, decidedRows] = await Promise.all([
    decisions.length ? supabase.from("source_transactions").select("id, row_number, original_row, status")
      .eq("workspace_id", workspace.id).eq("import_id", id).in("row_number", decisions.map(row => row.rowNumber)).gt("row_number", reviewedAfter).order("row_number").limit(PAGE_SIZE) : null,
    supabase.from("source_transactions")
      .select("id, row_number, original_row, external_id, normalized_row")
      .eq("workspace_id", workspace.id).eq("import_id", id).eq("status", "review")
      .gt("row_number", after).order("row_number").limit(PAGE_SIZE),
    supabase.from("accounts").select("id, name, currency_code, version, archived_at")
      .eq("workspace_id", workspace.id).order("name").limit(1000),
    (typeAfter ? typesQuery.gt("id", typeAfter) : typesQuery).order("id").limit(PAGE_SIZE),
    (historyBefore ? historyQuery.lt("created_at", historyBefore) : historyQuery).order("created_at", { ascending: false }).limit(HISTORY_SIZE),
    decidedQuery,
  ]);
  const decided = decidedRows.data?.filter(row => !decisions.some(item => item.rowNumber === row.row_number && item.action === "exclude")) ?? [];
  const decisionSources = [...(decidedRows.data ?? []), ...(rows ?? [])].map(row => row.id);
  const decisionEvents = decisionSources.length ? await supabase.from("import_row_decisions")
    .select("id, source_id, action, created_at, undone_at").eq("workspace_id", workspace.id)
    .in("source_id", decisionSources).order("created_at", { ascending: false }).limit(1000) : null;
  const complete = imported.status === "completed" && !imported.review_rows && !imported.classification_review_rows;

  return <main className="mx-auto w-full max-w-[1400px] space-y-8 px-4 py-6 sm:px-8 lg:py-8">
    <Link href="/import" className="text-sm underline">← Import history</Link>
    <div><p className="eyebrow">Money · Import review</p><h1 className="mt-2 page-title">Review: {imported.filename}</h1></div>
    <div id="review-progress" tabIndex={-1} role="status" className="space-y-2 rounded-lg border border-border p-4 text-sm outline-none">
      <p><span className="font-medium">{imported.review_rows} {imported.review_rows === 1 ? "row" : "rows"} to decide</span> <span className="text-muted-foreground">(left out of your totals until you decide)</span></p>
      <p><span className="font-medium">{imported.classification_review_rows} {imported.classification_review_rows === 1 ? "type" : "types"} to confirm</span> <span className="text-muted-foreground">(already in your balances, but income and spending are incomplete)</span></p>
      {complete && <p className="font-medium">Review complete. <Link className="text-brand underline" href="/money/transactions">Open transactions</Link></p>}
      {imported.status !== "completed" && <p className="text-muted-foreground">Decisions open once this import has finished. <Link className="underline" href="/import">Check its progress</Link></p>}
      <nav aria-label="Review sections" className="flex flex-wrap gap-x-4 gap-y-1"><a className="underline" href="#transaction-type">Transaction type</a><a className="underline" href="#source-coverage">Source coverage</a><a className="underline" href="#decided-rows">Decided rows</a><a className="underline" href="#type-history">Type history</a></nav>
    </div>
    {error && <p role="alert" className="text-sm text-danger">Could not load the rows to review. <Link className="underline" href={`/import/${id}/review`}>Try again</Link></p>}
    {destinations.error && <p role="alert" className="text-sm text-danger">Could not load your accounts, so a row whose account is unavailable cannot be accepted yet. <Link className="underline" href={`/import/${id}/review`}>Try again</Link></p>}
    {!error && !rows?.length && <p className="text-sm text-muted-foreground">{after > 0 ? <>No more rows after this point. <Link className="underline" href={`/import/${id}/review`}>Back to the first rows</Link></> : "No rows awaiting review."}</p>}
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
      const eligible = destinations.error ? [] : (destinations.data ?? []).filter(account => !account.archived_at && account.currency_code === currency);
      return <article className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6" key={row.id}>
      <h2 className="text-sm font-medium">Source row {row.row_number}</h2>
      {(decisionEvents?.data ?? []).filter(event => event.source_id === row.id && event.undone_at).map(event => <p className="text-xs text-muted-foreground" key={event.id}>Previously {event.action === "accepted" ? "accepted" : "rejected"}; reopened {new Date(event.undone_at!).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}. Original evidence is unchanged.</p>)}
      {interpreted ? <p className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><span className="min-w-0 break-words"><span className="font-medium">{interpreted.description}</span> <span className="font-mono text-xs text-muted-foreground">{interpreted.postedOn}</span></span><span className="font-mono font-medium tabular-nums">{formatMoney(BigInt(interpreted.amountMinor), interpreted.currencyCode, workspace.locale)}</span></p>
        : <p role="alert" className="text-sm">Moneo could not read this row. Check the original below before deciding.</p>}
      <p className="text-sm text-muted-foreground">Held back because it may overlap something you already have. It is not in your totals yet.</p>
      <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Original row{row.external_id ? ` · source ID ${row.external_id}` : ""}</summary><div className="mt-2"><SourceFields row={row.original_row as SourceRow} /></div></details>
      {imported.status === "completed" && row.external_id && frozenId && currency && normalized?.row?.status === "posted" &&
        <Suspense fallback={<p className="text-sm text-muted-foreground">Checking for matching pending payments…</p>}><PendingSettlement importId={id} sourceId={row.id} externalId={row.external_id} accountId={frozenId} currency={currency} /></Suspense>}
      {imported.status === "completed" && <ReviewActions importId={id} sourceId={row.id} rowNumber={row.row_number} frozenId={frozenId} frozenName={frozen?.name}
        unavailable={!frozen || !!frozen.archived_at || frozen.currency_code !== currency}
        destinations={eligible} />}
      {imported.status === "completed" && !destinations.error && !eligible.length && <p className="text-sm text-muted-foreground">You have no active account{currency ? ` in ${currency}` : ""} for this row. <Link className="underline" href="/money/accounts">Add one in Accounts</Link>, then come back to this page.</p>}
    </article>; })}
    {(after > 0 || rows?.length === PAGE_SIZE) && <nav aria-label="Review rows" className="flex flex-wrap items-center gap-4 text-sm">
      <span className="text-muted-foreground">Showing {rows?.length ?? 0} of the {imported.review_rows} left to review</span>
      {after > 0 && <Link className="underline" href={`/import/${id}/review`}>Back to the first rows</Link>}
      {rows?.length === PAGE_SIZE && <Link className="underline" href={`/import/${id}/review?after=${rows.at(-1)!.row_number}`}>Next {PAGE_SIZE}</Link>}
    </nav>}
    <section aria-label="Source coverage and reviewed interpretation" id="source-coverage" className="scroll-mt-20 space-y-4">
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
      {(reviewedAfter > 0 || decisionRows?.data?.length === PAGE_SIZE) && <p className="flex flex-wrap gap-4 text-sm">{reviewedAfter > 0 && <Link className="underline" href={`/import/${id}/review#source-coverage`}>Back to the first corrected rows</Link>}{decisionRows?.data?.length === PAGE_SIZE && <Link className="underline" href={`/import/${id}/review?reviewedAfter=${decisionRows.data.at(-1)!.row_number}#source-coverage`}>Next {PAGE_SIZE} corrected rows</Link>}</p>}
    </section>
    <section aria-labelledby="decided-rows" className="space-y-4">
      <h2 id="decided-rows" className="scroll-mt-20 text-sm font-medium">Decided rows</h2>
      <p className="text-sm text-muted-foreground">Rows you accepted or rejected on this page. Undo decision returns one row to review and preserves its history. Later edits or dependent records must be resolved first. For older decisions without a receipt, undo the whole import from <Link className="underline" href="/import">Import history</Link>, then import the file again. Undo shows what it would remove and refuses if other records depend on it. To fix one accepted transaction, open it instead.</p>
      {decidedRows.error && <p role="alert" className="text-sm text-danger">Could not load decided rows. <Link className="underline" href={`/import/${id}/review`}>Try again</Link></p>}
      {!decidedRows.error && !decided.length && <p className="text-sm text-muted-foreground">{decidedAfter ? "No more decided rows." : "None yet."}</p>}
      {decisionEvents?.error && <p role="alert" className="text-sm text-danger">Could not load decision history. Reload before undoing a decision.</p>}
      {decided.map(row => {
        const events = decisionEvents?.data?.filter(event => event.source_id === row.id) ?? [];
        const activeDecision = events.find(event => !event.undone_at);
        const interpreted = (row.normalized_row as { row?: { postedOn: string; description: string; amountMinor: string; currencyCode: string } } | null)?.row;
        const links = row.transaction_sources as unknown as { transaction_id: string } | { transaction_id: string }[] | null;
        const transactionId = (Array.isArray(links) ? links[0] : links)?.transaction_id;
        return <article key={row.id} className="space-y-2 rounded-lg border border-border p-4 text-sm">
          <h3 className="font-medium">Row {row.row_number} · {row.status === "rejected" ? "Rejected, not in your totals" : "Accepted"}</h3>
          {interpreted && <p className="break-words">{interpreted.description} · {interpreted.postedOn} · {formatMoney(BigInt(interpreted.amountMinor), interpreted.currencyCode, workspace.locale)}</p>}
          {row.status === "accepted" && transactionId && <Link className="underline" href={`/money/transactions?transaction=${transactionId}`}>Open the transaction</Link>}
          {events.length > 0 && <ol className="space-y-1 text-xs text-muted-foreground" aria-label={`Decision history for row ${row.row_number}`}>{events.map(event => <li key={event.id}>{event.action === "accepted" ? "Accepted" : "Rejected"} {new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}{event.undone_at ? ` - reopened ${new Date(event.undone_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}` : ""}</li>)}</ol>}
          {activeDecision && imported.status === "completed" ? <UndoRowDecision importId={id} sourceId={row.id} decisionId={activeDecision.id} rowNumber={row.row_number} /> : !decisionEvents?.error && <p className="text-xs text-muted-foreground">This older decision has no undo receipt. Open an accepted transaction to correct it, or use Undo import in Import history.</p>}
          <details><summary className="cursor-pointer text-muted-foreground">Original row</summary><div className="mt-2"><SourceFields row={row.original_row as SourceRow} /></div></details>
        </article>;
      })}
      {(decidedAfter > 0 || decidedRows.data?.length === PAGE_SIZE) && <p className="flex flex-wrap gap-4 text-sm">{decidedAfter > 0 && <Link className="underline" href={`/import/${id}/review#decided-rows`}>Back to the first decided rows</Link>}{decidedRows.data?.length === PAGE_SIZE && <Link className="underline" href={`/import/${id}/review?decidedAfter=${decidedRows.data.at(-1)!.row_number}#decided-rows`}>Next {PAGE_SIZE} decided rows</Link>}</p>}
    </section>
    <section className="space-y-4" aria-label="Financial classification review">
      <h2 id="transaction-type" className="scroll-mt-20 text-sm font-medium">Transaction type</h2>
      <p className="text-sm text-muted-foreground">{imported.classification_review_rows} rows still need a type: ordinary, refund or transfer between your accounts. Their amounts are already in your balances, but income and spending totals are incomplete until you review them.</p>
      {classifications.error && <p role="alert" className="text-sm text-danger">Could not load the transactions to type. <Link className="underline" href={`/import/${id}/review`}>Try again</Link></p>}
      {classifications.data?.map(transaction => <article className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6" key={transaction.id}>
        <h3 className="text-base font-semibold">{transaction.description} · {formatMoney(transaction.amount_minor, transaction.currency_code)}</h3>
        <p className="text-sm text-muted-foreground">Needs review: {transaction.review_reasons.map((reason: string) => reason.replaceAll("_", " ")).join(", ")}</p>
        <details className="text-sm"><summary className="cursor-pointer">Original row</summary><div className="mt-2 space-y-2">{(transaction.transaction_sources as unknown as { source_transactions: { row_number: number; original_row: SourceRow } }[]).map(link => <SourceFields key={link.source_transactions.row_number} row={link.source_transactions.original_row} />)}</div></details>
        <ClassificationActions importId={id} transactionId={transaction.id} version={transaction.version} reasons={transaction.review_reasons} name={transaction.description} />
      </article>)}
      {(typeAfter || classifications.data?.length === PAGE_SIZE) && <p className="flex flex-wrap gap-4 text-sm">{typeAfter && <Link className="underline" href={`/import/${id}/review#transaction-type`}>Back to the first transactions</Link>}{classifications.data?.length === PAGE_SIZE && <Link className="underline" href={`/import/${id}/review?typeAfter=${classifications.data.at(-1)!.id}#transaction-type`}>Next {PAGE_SIZE} transactions</Link>}</p>}
    </section>
    <section className="space-y-4" aria-label="Classification history"><h2 id="type-history" className="scroll-mt-20 text-sm font-medium">Transaction type history</h2>
      {reviewHistory.error && <p role="alert" className="text-sm text-danger">Could not load review history.</p>}
      {reviewHistory.data?.map(event => {
        const transaction = event.transactions as unknown as { version: number; description: string; amount_minor: string; currency_code: string };
        const kind = (event.after as { kind?: string } | null)?.kind;
        return <article className="space-y-3 rounded-lg border border-border p-4 text-sm" key={event.id}><p className="break-words font-medium">{transaction.description} · {formatMoney(transaction.amount_minor, transaction.currency_code)}{kind ? ` · set to ${kind}` : ""}</p><p>Reviewed {new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}{event.undone ? " · undone" : ""}</p>
          {!event.undone && <ClassificationActions importId={id} transactionId={event.transaction_id} version={transaction.version} eventId={event.id} name={transaction.description} />}
        </article>;
      })}
      {(historyBefore || reviewHistory.data?.length === HISTORY_SIZE) && <p className="flex flex-wrap gap-4 text-sm">{historyBefore && <Link className="underline" href={`/import/${id}/review#type-history`}>Back to the latest</Link>}{reviewHistory.data?.length === HISTORY_SIZE && <Link className="underline" href={`/import/${id}/review?historyBefore=${encodeURIComponent(reviewHistory.data.at(-1)!.created_at)}#type-history`}>Older reviews</Link>}</p>}
    </section>
  </main>;
}
