import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { TransactionTable } from "./table";
import { correctTransaction, undoCorrection, markTransfer, markRefund, clearLink } from "./actions";
import { SORT_ORDER, cursorClause, nextCursorForRow, parseTransactionParams, toQueryParams } from "./filters";

type Filters = { q?: string; from?: string; to?: string; account?: string; status?: string; kind?: string; direction?: string; category?: string; minAmount?: string; maxAmount?: string; sort?: string; cursor?: string; transaction?: string };

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Filters> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const params = await searchParams;
  const filters = parseTransactionParams(params as Record<string, string | undefined>);
  const [{ data: accounts }, { data: categories }] = await Promise.all([
    supabase.from("accounts").select("id, name")
      .eq("workspace_id", workspace.id).order("name"),
    supabase.from("categories").select("id, name")
      .eq("workspace_id", workspace.id).order("name"),
  ]);
  const { column, ascending } = SORT_ORDER[filters.sort];
  let query = supabase.from("transactions")
    .select("id, posted_on, description, amount_minor, currency_code, status, kind, account_id, category_id, note")
    .eq("workspace_id", workspace.id).order(column, { ascending }).order("id", { ascending }).limit(51);
  if (filters.q) query = query.ilike("description", `%${filters.q.replace(/[%_]/g, "\\$&")}%`);
  if (filters.from) query = query.gte("posted_on", filters.from);
  if (filters.to) query = query.lte("posted_on", filters.to);
  if (filters.accountId) query = query.eq("account_id", filters.accountId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.kind) query = query.eq("kind", filters.kind);
  if (filters.direction === "income") query = query.gt("amount_minor", 0);
  else if (filters.direction === "outflow") query = query.lt("amount_minor", 0);
  if (filters.categoryId) query = query.eq("category_id", filters.categoryId);
  else if (filters.uncategorized) query = query.is("category_id", null);
  if (filters.minAmountMinor !== undefined) query = query.gte("amount_minor", filters.minAmountMinor);
  if (filters.maxAmountMinor !== undefined) query = query.lte("amount_minor", filters.maxAmountMinor);
  if (filters.cursor) query = query.or(cursorClause(filters.sort, filters.cursor));
  const { data, error } = await query;
  const rows = data?.slice(0, 50) ?? [];
  const next = data && data.length > 50 && rows.length === 50
    ? nextCursorForRow(rows[49] as { posted_on: string; amount_minor: string; id: string }, filters.sort)
    : null;
  const { data: selected } = filters.transactionId ? await supabase.from("transactions")
    .select("*").eq("workspace_id", workspace.id).eq("id", filters.transactionId).maybeSingle() : { data: null };
  const { data: sources } = selected ? await supabase.from("transaction_sources")
    .select("source_transactions(original_row, import_id, row_number)")
    .eq("transaction_id", selected.id) : { data: null };
  const { data: history } = selected ? await supabase.from("correction_events")
    .select("id, before, after, undone, created_at").eq("workspace_id", workspace.id)
    .eq("transaction_id", selected.id).order("created_at", { ascending: false }) : { data: null };
  const { data: category } = selected?.category_id ? await supabase.from("categories")
    .select("name").eq("workspace_id", workspace.id).eq("id", selected.category_id).maybeSingle() : { data: null };
  const selectedAmount = (() => { try { return BigInt(selected?.amount_minor ?? ""); } catch { return null; } })();
  const negatedAmount = selectedAmount === null ? null : String(-selectedAmount);
  const { data: counterpart } = selected?.transfer_id ? await supabase.from("transactions")
    .select("id, description, posted_on, amount_minor, currency_code, account_id, kind, status")
    .eq("workspace_id", workspace.id).eq("id", selected.transfer_id).maybeSingle() : { data: null };
  const { data: refundOriginal } = selected?.refund_of_id ? await supabase.from("transactions")
    .select("id, description, posted_on, amount_minor, currency_code, account_id, kind, status")
    .eq("workspace_id", workspace.id).eq("id", selected.refund_of_id).maybeSingle() : { data: null };
  const { data: inboundRefunds } = selected ? await supabase.from("transactions")
    .select("id, description, posted_on, amount_minor, currency_code")
    .eq("workspace_id", workspace.id).eq("refund_of_id", selected.id)
    .order("posted_on", { ascending: false }).limit(10) : { data: null };
  const { data: inboundTransfer } = selected ? await supabase.from("transactions")
    .select("id, description, posted_on, amount_minor, currency_code, account_id, kind")
    .eq("workspace_id", workspace.id).eq("transfer_id", selected.id).limit(5) : { data: null };
  let transferCandidates: { id: string; description: string; posted_on: string; amount_minor: string; currency_code: string; account_id: string }[] | null = null;
if (selected && selected.status === "posted" && selected.kind === "ordinary" && negatedAmount !== null) {
    const { data } = await supabase.from("transactions")
      .select("id, description, posted_on, amount_minor, currency_code, account_id")
      .eq("workspace_id", workspace.id).neq("id", selected.id).neq("account_id", selected.account_id)
    .eq("currency_code", selected.currency_code).eq("amount_minor", negatedAmount).eq("status", "posted").eq("kind", "ordinary")
      .order("posted_on", { ascending: false }).limit(20);
    transferCandidates = data;
  }
  let refundCandidates: { id: string; description: string; posted_on: string; amount_minor: string; currency_code: string }[] | null = null;
if (selected && selected.status === "posted" && selected.kind === "ordinary" && selectedAmount !== null && selectedAmount > 0n) {
    let candidateQuery = supabase.from("transactions")
      .select("id, description, posted_on, amount_minor, currency_code")
      .eq("workspace_id", workspace.id).eq("account_id", selected.account_id)
    .eq("currency_code", selected.currency_code).neq("id", selected.id).eq("kind", "ordinary").eq("status", "posted")
    .lte("posted_on", selected.posted_on);
  candidateQuery = candidateQuery.lt("amount_minor", 0);
    const { data } = await candidateQuery.order("posted_on", { ascending: false }).limit(20);
    refundCandidates = data;
  }
  const names = Object.fromEntries((accounts ?? []).map(account => [account.id, account.name]));
  const current = toQueryParams(filters, { includeCursor: true });
  const baseQuery = toQueryParams(filters).toString();
  const nextParams = toQueryParams(filters);
  if (next) nextParams.set("cursor", next);

  return <main className="mx-auto max-w-6xl px-6 py-10">
    <header className="flex items-center justify-between"><div><Link href="/" className="text-sm text-muted-foreground">← Home</Link><h1 className="mt-2 text-3xl font-semibold">Transactions</h1><Link href="/money/recurring" className="mt-2 inline-block text-sm underline">Review recurring patterns</Link></div><Link href="/import" className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground">Import</Link></header>
    <form className="mt-8 flex flex-wrap gap-3" method="get">
      <input name="q" defaultValue={filters.q} placeholder="Search descriptions" aria-label="Search descriptions" className="rounded border p-2" />
      <input name="from" type="date" defaultValue={filters.from} aria-label="From date" className="rounded border p-2" />
      <input name="to" type="date" defaultValue={filters.to} aria-label="To date" className="rounded border p-2" />
      <select name="account" defaultValue={filters.accountId ?? ""} aria-label="Account" className="rounded border p-2"><option value="">All accounts</option>{accounts?.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select>
      <select name="category" defaultValue={filters.uncategorized ? "none" : filters.categoryId ?? ""} aria-label="Category" className="rounded border p-2"><option value="">All categories</option><option value="none">Uncategorized</option>{categories?.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
      <input name="minAmount" defaultValue={filters.minAmountMinor} placeholder="Min (minor units)" aria-label="Minimum amount in minor units" inputMode="numeric" pattern="-?[0-9]+" title="Exact amount in minor units, e.g. cents (no decimals)" className="w-36 rounded border p-2" />
      <input name="maxAmount" defaultValue={filters.maxAmountMinor} placeholder="Max (minor units)" aria-label="Maximum amount in minor units" inputMode="numeric" pattern="-?[0-9]+" title="Exact amount in minor units, e.g. cents (no decimals)" className="w-36 rounded border p-2" />
      <select name="status" defaultValue={filters.status ?? ""} aria-label="Status" className="rounded border p-2"><option value="">All statuses</option><option value="posted">Posted</option><option value="pending">Pending</option></select>
      <select name="kind" defaultValue={filters.kind ?? ""} aria-label="Type" className="rounded border p-2"><option value="">All types</option><option value="ordinary">Ordinary</option><option value="transfer">Transfer</option><option value="refund">Refund</option></select>
      <select name="direction" defaultValue={filters.direction ?? ""} aria-label="Direction" className="rounded border p-2"><option value="">Income and outflow</option><option value="income">Income</option><option value="outflow">Outflow</option></select>
      <select name="sort" defaultValue={filters.sort} aria-label="Sort order" className="rounded border p-2"><option value="date-desc">Newest first</option><option value="date-asc">Oldest first</option><option value="amount-desc">Largest amount first</option><option value="amount-asc">Smallest amount first</option></select>
      <button className="rounded border px-4">Filter</button>
    </form>
    {error ? <p role="alert" className="mt-6">Could not load transactions: {error.message}</p> : <TransactionTable rows={rows} accountNames={names} query={current.toString()} sort={filters.sort} baseQuery={baseQuery} />}
    {next && <Link className="mt-5 inline-block underline" href={`/money/transactions?${nextParams}`}>Next page</Link>}
    {selected && <aside aria-label="Transaction details" className="fixed inset-y-0 right-0 w-full max-w-md overflow-y-auto border-l bg-background p-6 shadow-xl">
      <Link href={`/money/transactions?${current}`} className="text-sm underline">Close</Link>
      <h2 className="mt-6 text-xl font-semibold">{selected.description}</h2>
      <p className="mt-2">{selected.posted_on} · {selected.amount_minor} minor units {selected.currency_code}</p>
      <dl className="mt-6 space-y-2 text-sm"><div><dt className="text-muted-foreground">Account</dt><dd>{names[selected.account_id]}</dd></div><div><dt className="text-muted-foreground">Status</dt><dd>{selected.status}</dd></div><div><dt className="text-muted-foreground">Type</dt><dd>{selected.kind}</dd></div><div><dt className="text-muted-foreground">Note</dt><dd>{selected.note || "—"}</dd></div></dl>
      <section aria-label="Transfer or refund" className="mt-6 space-y-3 border-t pt-5">
        <h3 className="font-medium">Transfer / refund</h3>
        <p className="text-sm text-muted-foreground">Transfers are excluded from income and spending. Refunds reduce spending in the refund posting period. Markings are audited and can be undone from the history below.</p>
        {counterpart && <p className="text-sm">Transfer pair: <Link className="underline" href={`/money/transactions?${current.toString()}${current.toString() ? "&" : ""}transaction=${counterpart.id}`}>{counterpart.description} · {counterpart.posted_on}</Link></p>}
        {refundOriginal && <p className="text-sm">Refund of: <Link className="underline" href={`/money/transactions?${current.toString()}${current.toString() ? "&" : ""}transaction=${refundOriginal.id}`}>{refundOriginal.description} · {refundOriginal.posted_on}</Link></p>}
        {inboundRefunds?.length ? <div className="text-sm"><p className="text-muted-foreground">Refunds of this transaction:</p><ul className="mt-1 space-y-1">{inboundRefunds.map(item => <li key={item.id}><Link className="underline" href={`/money/transactions?${current.toString()}${current.toString() ? "&" : ""}transaction=${item.id}`}>{item.description} · {item.posted_on}</Link></li>)}</ul></div> : null}
        {inboundTransfer?.filter(item => item.id !== counterpart?.id).map(item => <p key={item.id} className="text-sm text-muted-foreground">Also linked here as transfer: {item.description} · {item.posted_on}</p>)}
        {selected.status !== "posted" ? <p className="text-sm text-muted-foreground">Only posted transactions can be marked as transfers or refunds.</p> : <>
          {selected.kind === "ordinary" && <form action={markTransfer} className="space-y-2">
            <input type="hidden" name="id" value={selected.id} /><input type="hidden" name="version" value={selected.version} /><input type="hidden" name="query" value={current.toString()} />
            <label className="block text-sm">Transfer counterpart (different account, opposite matching {selected.currency_code} amount)<select name="counterpartId" required defaultValue="" aria-label="Transfer counterpart" className="mt-1 block w-full rounded border p-2"><option value="" disabled>Select counterpart</option>{transferCandidates?.map(item => <option key={item.id} value={item.id}>{item.posted_on} · {item.description} · {names[item.account_id] ?? "Unknown account"} · {item.amount_minor} {item.currency_code}</option>)}</select></label>
            {!transferCandidates?.length && <p className="text-sm text-muted-foreground">No matching counterpart found (needs the opposite amount in the same currency from another account).</p>}
            <button className="rounded border px-4 py-2 text-sm" disabled={!transferCandidates?.length}>Mark as transfer</button>
          </form>}
          {selected.kind === "ordinary" && selectedAmount !== null && selectedAmount > 0n && <form action={markRefund} className="space-y-2 border-t pt-4">
            <input type="hidden" name="id" value={selected.id} /><input type="hidden" name="version" value={selected.version} /><input type="hidden" name="query" value={current.toString()} />
            <label className="block text-sm">Refund original (same account, same currency, opposite sign)<select name="originalId" defaultValue="" aria-label="Refund original" className="mt-1 block w-full rounded border p-2"><option value="">Standalone refund (no original)</option>{refundCandidates?.map(item => <option key={item.id} value={item.id}>{item.posted_on} · {item.description} · {item.amount_minor} {item.currency_code}</option>)}</select></label>
            <button className="rounded border px-4 py-2 text-sm">Mark as refund</button>
          </form>}
          {(selected.kind !== "ordinary" || selected.transfer_id || selected.refund_of_id) && <form action={clearLink} className="border-t pt-4"><input type="hidden" name="id" value={selected.id} /><input type="hidden" name="version" value={selected.version} /><input type="hidden" name="query" value={current.toString()} /><button className="text-sm underline">Clear to ordinary</button></form>}
        </>}
      </section>
      <form action={correctTransaction} className="mt-6 space-y-3 border-t pt-5">
        <input type="hidden" name="id" value={selected.id} /><input type="hidden" name="version" value={selected.version} /><input type="hidden" name="query" value={current.toString()} />
        <label className="block text-sm">Category<input name="category" defaultValue={category?.name ?? ""} maxLength={100} className="mt-1 block w-full rounded border p-2" /></label>
        <label className="block text-sm">Note<textarea name="note" defaultValue={selected.note ?? ""} maxLength={2000} className="mt-1 block w-full rounded border p-2" /></label>
        <button className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground">Save correction</button>
      </form>
      <h3 className="mt-8 font-medium">Original source</h3><pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{JSON.stringify(sources ?? [], null, 2)}</pre>
      <h3 className="mt-8 font-medium">Correction history</h3>
      {history?.length ? <ul className="mt-2 space-y-2 text-sm">{history.map((event, index) => <li key={event.id} className="rounded border p-3">
        <p>{new Date(event.created_at).toLocaleString()} {event.undone ? "· undone" : ""}</p>
        <pre className="mt-2 whitespace-pre-wrap text-xs">{JSON.stringify({ before: event.before, after: event.after }, null, 2)}</pre>
        {index === history.findIndex(item => !item.undone) && <form action={undoCorrection} className="mt-3"><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="transactionId" value={selected.id} /><input type="hidden" name="version" value={selected.version} /><input type="hidden" name="query" value={current.toString()} /><button className="underline">Undo correction</button></form>}
      </li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">No corrections yet.</p>}
    </aside>}
  </main>;
}
