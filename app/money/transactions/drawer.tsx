import Link from "next/link";
import { requireWorkspace } from "@/lib/auth";
import { formatMoney } from "@/lib/finance/format";
import { applyCategoryToSimilar, clearLink, markRefund, quickEditTransaction, undoCorrection, undoTransactionSplits, undoVerifiedLink } from "./actions";
import { SplitEditor } from "./split-editor";
import { AskAbout } from "@/components/ask-about";
import { VerifiedLinkEditor, type LinkPosting } from "./verified-link-editor";
import { PendingHoldPanel } from "./pending-hold-panel";
import { similarRows } from "./similar";
import { describeChanges, kindLabel, operationLabel, reviewReasonLabel, statusLabel } from "./labels";

type Named = { id: string; name: string };
const LINK_COLUMNS = "id, version, description, posted_on, amount_minor::text, currency_code";
const field = "mt-1 block w-full rounded-lg border border-border bg-card px-3 py-2 text-sm";

function escapeLike(value: string) { return value.replace(/[%_]/g, "\\$&"); }

/**
 * Transaction drawer: quick edit (category, merchant, note), splits,
 * transfer/refund links, correction history with Undo and the original
 * source evidence. Every query that only needs the id runs in one parallel
 * wave; the dependent ones run in a second wave.
 */
export async function TransactionDrawer({ id, query, linkSearch, accountNames, categories, merchants }: {
  id: string; query: string; linkSearch: string; accountNames: Record<string, string>; categories: Named[]; merchants: Named[];
}) {
  const { supabase, workspace } = await requireWorkspace();
  const money = (amount: string | bigint, currency: string) => formatMoney(amount, currency, workspace.locale);
  const ws = workspace.id;
  const [selectedResult, sources, manualSource, splitSet, history, inboundRefunds, inboundTransfer, receipt, rates] = await Promise.all([
    supabase.from("transactions").select("*, amount_minor::text").eq("workspace_id", ws).eq("id", id).maybeSingle(),
    supabase.from("transaction_sources").select("source_transactions(original_row, fee_evidence, import_id, row_number)").eq("transaction_id", id),
    supabase.from("manual_transaction_entries").select("original_record, created_at").eq("workspace_id", ws).eq("transaction_id", id).maybeSingle(),
    supabase.from("transaction_split_sets").select("id").eq("workspace_id", ws).eq("transaction_id", id).is("undone_at", null).maybeSingle(),
    supabase.from("correction_events").select("id, before, after, undone, created_at").eq("workspace_id", ws).eq("transaction_id", id).order("created_at", { ascending: false }),
    supabase.from("transactions").select("id, description, posted_on").eq("workspace_id", ws).eq("refund_of_id", id).order("posted_on", { ascending: false }).limit(10),
    supabase.from("transactions").select("id, description, posted_on").eq("workspace_id", ws).eq("transfer_id", id).limit(5),
    supabase.from("transaction_links").select("id, operation, fx_evidence, original_equivalent_minor::text").eq("workspace_id", ws).is("undone_at", null)
      .or(`primary_transaction_id.eq.${id},and(operation.eq.transfer,counterpart_transaction_id.eq.${id})`).maybeSingle(),
    supabase.from("fx_rates").select("id, from_currency, to_currency, rate_text, rate_date, source").eq("workspace_id", ws).order("rate_date", { ascending: false }).limit(100),
  ]);
  for (const result of [selectedResult, splitSet, receipt, rates]) if (result.error) throw result.error;
  const selected = selectedResult.data;
  const close = <Link href={`/money/transactions?${query}`} scroll={false} className="text-sm text-muted-foreground underline hover:text-foreground">Close</Link>;
  if (!selected) return <aside aria-label="Transaction details" className="fixed inset-y-0 right-0 z-50 w-full max-w-lg border-l border-border bg-card p-6 shadow-2xl">{close}<p role="alert" className="mt-6 text-sm">This transaction isn’t available.</p></aside>;

  const amount = BigInt(selected.amount_minor);
  const linked = Boolean(receipt.data);
  const canLinkTransfer = selected.status === "posted" && selected.kind === "ordinary" && !linked;
  const canLinkRefund = selected.status === "posted" && ["ordinary", "refund"].includes(selected.kind) && !linked && !selected.refund_of_id && amount > 0n;
  const candidateBase = () => supabase.from("transactions").select(LINK_COLUMNS).eq("workspace_id", ws).neq("id", selected.id).eq("status", "posted").eq("kind", "ordinary").is("transfer_id", null).is("refund_of_id", null);
  const transferQuery = () => { let q = candidateBase().neq("account_id", selected.account_id); q = amount < 0n ? q.gt("amount_minor", 0) : q.lt("amount_minor", 0); if (linkSearch) q = q.ilike("description", `%${escapeLike(linkSearch)}%`); return q.order("posted_on", { ascending: false }).order("id").limit(100); };
  const refundQuery = () => { let q = candidateBase().eq("review_reasons", "{}").lte("posted_on", selected.posted_on).lt("amount_minor", 0); if (linkSearch) q = q.ilike("description", `%${escapeLike(linkSearch)}%`); return q.order("posted_on", { ascending: false }).order("id").limit(100); };
  const none = { data: null, error: null };
  const [splitRows, counterpart, refundOriginal, fees, transferCandidates, refundCandidates] = await Promise.all([
    splitSet.data ? supabase.from("transaction_splits").select("id, amount_minor::text, category_id, note, ordinal").eq("workspace_id", ws).eq("split_set_id", splitSet.data.id).order("ordinal") : none,
    selected.transfer_id ? supabase.from("transactions").select("id, description, posted_on, version, currency_code").eq("workspace_id", ws).eq("id", selected.transfer_id).maybeSingle() : none,
    selected.refund_of_id ? supabase.from("transactions").select("id, description, posted_on").eq("workspace_id", ws).eq("id", selected.refund_of_id).maybeSingle() : none,
    receipt.data ? supabase.from("transaction_link_fees").select("transaction_id, fee_minor::text, treatment, note").eq("workspace_id", ws).eq("link_id", receipt.data.id) : none,
    canLinkTransfer ? transferQuery() : none,
    canLinkRefund ? refundQuery() : none,
  ]);
  for (const result of [splitRows, fees, transferCandidates, refundCandidates]) if (result.error) throw result.error;
  const similar = splitSet.data ? [] : (await similarRows(supabase, ws, selected)).rows;

  const categoryNames = Object.fromEntries(categories.map(row => [row.id, row.name]));
  const merchantNames = Object.fromEntries(merchants.map(row => [row.id, row.name]));
  const names = { categories: categoryNames, merchants: merchantNames };
  const open = (other: string) => `/money/transactions?${query}${query ? "&" : ""}transaction=${other}`;
  const versionRows = JSON.stringify([{ id: selected.id, version: selected.version }, ...(counterpart.data ? [{ id: counterpart.data.id, version: counterpart.data.version }] : [])]);
  const hidden = (name: string, value: string | number) => <input type="hidden" name={name} value={value} />;
  const categoryName = selected.category_id ? categoryNames[selected.category_id] ?? "" : "";
  const latestUndoable = history.data?.findIndex(item => !item.undone) ?? -1;
  const originals = (sources.data ?? []).flatMap(source => [source.source_transactions].flat().filter(Boolean)) as { import_id: string; row_number: number }[];
  const canSplit = selected.kind === "ordinary" && selected.status === "posted" && !selected.review_reasons?.length && !selected.transfer_id && !selected.refund_of_id && !inboundRefunds.data?.length && !inboundTransfer.data?.length;

  return <aside aria-label="Transaction details" className="fixed inset-y-0 right-0 z-50 w-full max-w-lg overflow-y-auto border-l border-border bg-card shadow-2xl">
    <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-6 py-3">{close}<span className="text-xs text-muted-foreground">Esc to close · j/k to move</span></div>
    <div className="space-y-6 p-6">
      <header>
        <p className="font-mono text-[11px] text-subtle">{selected.posted_on} · {accountNames[selected.account_id] ?? "Unknown account"} · {statusLabel(selected.status)} · {kindLabel(selected.kind)}</p>
        <h2 className="mt-1.5 font-display text-[28px] font-semibold leading-tight tracking-tight">{selected.description}</h2>
        <p className={`mt-1 font-mono text-[26px] tabular-nums ${amount > 0n ? "text-success" : ""}`}>{money(amount, selected.currency_code)}</p>
        <p className="mt-2 flex flex-wrap gap-3"><AskAbout question="Explain this transaction: is it normal for me, is it recurring, and how does it compare with similar ones?" about={{ kind: "transaction", id: selected.id, label: `${selected.posted_on} · ${selected.description.slice(0, 60)}` }} /></p>
        {(selected.tags?.length || selected.event_name) ? <p className="mt-1 text-sm text-muted-foreground">{selected.tags?.length ? `Tags: ${selected.tags.join(", ")}` : ""}{selected.tags?.length && selected.event_name ? " · " : ""}{selected.event_name ? `Group: ${selected.event_name}` : ""}</p> : null}
      </header>

      {selected.review_reasons?.length ? <div role="alert" className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
        <p>Check this before relying on it for spending: {selected.review_reasons.map(reviewReasonLabel).join("; ")}.</p>
        {originals.map(original => <Link key={`${original.import_id}-${original.row_number}`} href={`/import/${original.import_id}/review`} className="mr-3 underline">Review import row {original.row_number}</Link>)}
      </div> : null}

      {selected.status === "pending" && selected.kind === "ordinary" && amount < 0n && <PendingHoldPanel transaction={selected} />}

      <form action={quickEditTransaction} className="space-y-3" aria-label="Quick edit">
        {hidden("id", selected.id)}{hidden("version", selected.version)}{hidden("query", query)}{hidden("requestId", crypto.randomUUID())}
        {hidden("originalCategory", categoryName)}{hidden("originalNote", selected.note ?? "")}{hidden("originalMerchant", selected.merchant_id ?? "")}
        <label className="block text-sm">Category<input name="category" list="drawer-categories" defaultValue={categoryName} readOnly={!!splitSet.data} maxLength={100} placeholder="Uncategorized" className={field} /></label>
        <datalist id="drawer-categories">{categories.map(category => <option key={category.id} value={category.name} />)}</datalist>
        {splitSet.data ? <p className="text-xs text-muted-foreground">Undo the split to change the category.</p> : <p className="text-xs text-muted-foreground">Type a new name to create a category.</p>}
        <label className="block text-sm">Merchant<select name="merchant" defaultValue={selected.merchant_id ?? ""} className={field}><option value="">Unknown merchant</option>{merchants.map(merchant => <option key={merchant.id} value={merchant.id}>{merchant.name}</option>)}</select></label>
        <label className="block text-sm">Note<textarea name="note" defaultValue={selected.note ?? ""} maxLength={2000} rows={2} className={field} /></label>
        <button className="rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90">Save correction</button>
        <p className="text-xs text-muted-foreground">Each change is recorded below and can be undone.</p>
      </form>

      {similar.length > 0 && <form action={applyCategoryToSimilar} aria-label="Similar transactions" className="space-y-2 rounded-lg border border-border p-3 text-sm">
        {hidden("id", selected.id)}{hidden("query", query)}
        <p>{similar.length} other {similar.length === 1 ? "transaction has" : "transactions have"} this description but {similar.length === 1 ? "is" : "are"} not in {categoryName}.</p>
        <button className="rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-muted">Put {similar.length === 1 ? "it" : `all ${similar.length}`} in {categoryName}</button>
        <p className="text-xs text-muted-foreground">Also saves a rule so future imports and agent runs use {categoryName}. Undo from <Link href="/money/organization" className="underline">Organization</Link>.</p>
      </form>}

      {splitSet.data ? <section aria-label="Split allocations" className="rounded-lg border border-border p-3">
        <h3 className="font-medium">Split allocations</h3>
        <p className="mt-1 text-xs text-muted-foreground">The original amount, source and category are kept. Balances count the original once; spending uses these allocations. Undo the split before changing the category or linking transfers or refunds.</p>
        <ul className="mt-2 text-sm">{splitRows.data?.map(row => <li key={row.id}>{money(row.amount_minor, selected.currency_code)} · {categoryNames[row.category_id ?? ""] ?? "Uncategorized"}{row.note ? ` · ${row.note}` : ""}</li>)}</ul>
        <form action={undoTransactionSplits} className="mt-3">{hidden("setId", splitSet.data.id)}{hidden("id", selected.id)}{hidden("version", selected.version)}{hidden("query", query)}<button className="text-sm underline">Undo splits</button></form>
      </section> : canSplit && <SplitEditor locale={workspace.locale} id={selected.id} version={selected.version} amountMinor={selected.amount_minor} currency={selected.currency_code} categories={categories} query={query} requestId={crypto.randomUUID()} />}

      <section aria-label="Transfer or refund" className="space-y-3 border-t border-border pt-5">
        <h3 className="font-medium">Transfer or refund</h3>
        <p className="text-sm text-muted-foreground">Transfers don’t count as income or spending. Refunds reduce spending in the month they arrive. Links can be undone from the history below.</p>
        {counterpart.data && <p className="text-sm">Transfer pair: <Link className="underline" href={open(counterpart.data.id)}>{counterpart.data.description} · {counterpart.data.posted_on}</Link></p>}
        {refundOriginal.data && <p className="text-sm">Refund of: <Link className="underline" href={open(refundOriginal.data.id)}>{refundOriginal.data.description} · {refundOriginal.data.posted_on}</Link></p>}
        {inboundRefunds.data?.length ? <div className="text-sm"><p className="text-muted-foreground">Refunds of this transaction:</p><ul className="mt-1 space-y-1">{inboundRefunds.data.map(item => <li key={item.id}><Link className="underline" href={open(item.id)}>{item.description} · {item.posted_on}</Link></li>)}</ul></div> : null}
        {inboundTransfer.data?.filter(item => item.id !== counterpart.data?.id).map(item => <p key={item.id} className="text-sm text-muted-foreground">Also linked here as a transfer: {item.description} · {item.posted_on}</p>)}
        {splitSet.data ? <p className="text-sm text-muted-foreground">Undo the split before linking this as a transfer or refund.</p> : selected.status !== "posted" ? <p className="text-sm text-muted-foreground">Only posted transactions can be linked as transfers or refunds.</p> : <>
          {receipt.data ? <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
            <p>Verified {receipt.data.operation === "refund" ? "refund" : "transfer"}. The original source amounts are kept.</p>
            {fees.data?.length ? <ul className="text-muted-foreground">{fees.data.map(fee => <li key={fee.transaction_id}>Fee {money(fee.fee_minor, fee.transaction_id === selected.id ? selected.currency_code : counterpart.data?.currency_code ?? selected.currency_code)} ({fee.treatment === "included" ? "included in the posting" : "charged separately"}) · {fee.note}</li>)}</ul> : null}
            {receipt.data.fx_evidence ? <details><summary className="cursor-pointer text-muted-foreground">Exchange-rate evidence</summary><pre className="mt-2 whitespace-pre-wrap text-xs">{JSON.stringify(receipt.data.fx_evidence, null, 2)}</pre></details> : null}
            <form action={undoVerifiedLink}>{hidden("id", selected.id)}{hidden("linkId", receipt.data.id)}{hidden("query", query)}{hidden("rows", versionRows)}<button className="underline">Undo verified link</button></form>
          </div> : <>
            <form method="get" className="flex flex-wrap items-end gap-2">{hidden("transaction", selected.id)}<label className="text-sm">Find the other side by description<input name="linkSearch" defaultValue={linkSearch} maxLength={200} className={field} /></label><button className="rounded-lg border border-border px-3 py-2 text-sm">Search</button></form>
            {canLinkTransfer && <VerifiedLinkEditor locale={workspace.locale} operation="transfer" primary={selected} candidates={(transferCandidates.data ?? []) as LinkPosting[]} rates={rates.data ?? []} categories={categories} query={query} />}
            {canLinkRefund && <><VerifiedLinkEditor locale={workspace.locale} operation="refund" primary={selected} candidates={(refundCandidates.data ?? []) as LinkPosting[]} rates={rates.data ?? []} categories={categories} query={query} />
              <form action={markRefund}>{hidden("id", selected.id)}{hidden("version", selected.version)}{hidden("query", query)}<button className="text-sm underline">Mark as a refund without linking a purchase</button></form></>}
          </>}
          {!receipt.data && (selected.kind !== "ordinary" || selected.transfer_id || selected.refund_of_id) && <form action={clearLink} className="border-t border-border pt-4">{hidden("id", selected.id)}{hidden("version", selected.version)}{hidden("query", query)}<button className="text-sm underline">Make this a regular transaction again</button></form>}
        </>}
      </section>

      <section aria-label="Correction history" className="border-t border-border pt-5">
        <h3 className="font-medium">Correction history</h3>
        {history.data?.length ? <ol className="mt-2 space-y-2 text-sm">{history.data.map((event, index) => {
          const changes = describeChanges(event.before, event.after, names);
          return <li key={event.id} className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">{operationLabel((event.after as { operation?: unknown })?.operation)} · {new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}{event.undone ? " · Undone" : ""}</p>
            <ul className={`mt-1 ${event.undone ? "text-muted-foreground line-through" : ""}`}>{(changes.length ? changes : ["No visible field changes"]).map(change => <li key={change}>{change}</li>)}</ul>
            {index === latestUndoable && <form action={undoCorrection} className="mt-2">{hidden("rows", versionRows)}{hidden("eventId", event.id)}{hidden("transactionId", selected.id)}{hidden("version", selected.version)}{hidden("query", query)}<button className="underline">Undo correction</button></form>}
          </li>;
        })}</ol> : <p className="mt-2 text-sm text-muted-foreground">No corrections yet.</p>}
      </section>

      <details className="border-t border-border pt-5">
        <summary className="cursor-pointer font-medium">Original source</summary>
        <p className="mt-2 text-xs text-muted-foreground">Exactly as imported or entered. This record never changes.</p>
        <pre aria-label="Original source evidence" className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{JSON.stringify(manualSource.data ? { type: "manual", ...manualSource.data } : sources.data ?? [], null, 2)}</pre>
      </details>
    </div>
  </aside>;
}
