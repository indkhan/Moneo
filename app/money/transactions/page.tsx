import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { TransactionTable } from "./table";
import { correctTransaction, undoCorrection } from "./actions";

type Filters = { q?: string; from?: string; to?: string; account?: string; status?: string; kind?: string; direction?: string; cursor?: string; transaction?: string };

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Filters> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const params = await searchParams;
  const { data: accounts } = await supabase.from("accounts").select("id, name")
    .eq("workspace_id", workspace.id).order("name");
  let query = supabase.from("transactions")
    .select("id, posted_on, description, amount_minor, currency_code, status, kind, account_id, category_id, note")
    .eq("workspace_id", workspace.id).order("posted_on", { ascending: false }).order("id", { ascending: false }).limit(51);
  if (params.q) query = query.ilike("description", `%${params.q.replace(/[%_]/g, "\\$&")}%`);
  if (params.from) query = query.gte("posted_on", params.from);
  if (params.to) query = query.lte("posted_on", params.to);
  if (params.account) query = query.eq("account_id", params.account);
  const status = params.status === "posted" || params.status === "pending" ? params.status : undefined;
  const kind = params.kind === "ordinary" || params.kind === "transfer" || params.kind === "refund" ? params.kind : undefined;
  const direction = params.direction === "income" || params.direction === "outflow" ? params.direction : undefined;
  if (status) query = query.eq("status", status);
  if (kind) query = query.eq("kind", kind);
  if (direction === "income") query = query.gt("amount_minor", 0);
  else if (direction === "outflow") query = query.lt("amount_minor", 0);
  if (params.cursor) {
    const [date, id] = params.cursor.split("|");
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^[0-9a-f-]{36}$/i.test(id))
      query = query.or(`posted_on.lt.${date},and(posted_on.eq.${date},id.lt.${id})`);
  }
  const { data, error } = await query;
  const rows = data?.slice(0, 50) ?? [];
  const next = data && data.length > 50 ? `${rows[49].posted_on}|${rows[49].id}` : null;
  const { data: selected } = params.transaction ? await supabase.from("transactions")
    .select("*").eq("workspace_id", workspace.id).eq("id", params.transaction).maybeSingle() : { data: null };
  const { data: sources } = selected ? await supabase.from("transaction_sources")
    .select("source_transactions(original_row, import_id, row_number)")
    .eq("transaction_id", selected.id) : { data: null };
  const { data: history } = selected ? await supabase.from("correction_events")
    .select("id, before, after, undone, created_at").eq("workspace_id", workspace.id)
    .eq("transaction_id", selected.id).order("created_at", { ascending: false }) : { data: null };
  const { data: category } = selected?.category_id ? await supabase.from("categories")
    .select("name").eq("workspace_id", workspace.id).eq("id", selected.category_id).maybeSingle() : { data: null };
  const names = Object.fromEntries((accounts ?? []).map(account => [account.id, account.name]));
  const current = new URLSearchParams();
  for (const key of ["q", "from", "to", "account", "cursor"] as const) if (params[key]) current.set(key, params[key]);
  if (status) current.set("status", status);
  if (kind) current.set("kind", kind);
  if (direction) current.set("direction", direction);

  return <main className="mx-auto max-w-6xl px-6 py-10">
    <header className="flex items-center justify-between"><div><Link href="/" className="text-sm text-muted-foreground">← Home</Link><h1 className="mt-2 text-3xl font-semibold">Transactions</h1></div><Link href="/import" className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground">Import</Link></header>
    <form className="mt-8 flex flex-wrap gap-3" method="get">
      <input name="q" defaultValue={params.q} placeholder="Search descriptions" aria-label="Search descriptions" className="rounded border p-2" />
      <input name="from" type="date" defaultValue={params.from} aria-label="From date" className="rounded border p-2" />
      <input name="to" type="date" defaultValue={params.to} aria-label="To date" className="rounded border p-2" />
      <select name="account" defaultValue={params.account ?? ""} aria-label="Account" className="rounded border p-2"><option value="">All accounts</option>{accounts?.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select>
      <select name="status" defaultValue={status ?? ""} aria-label="Status" className="rounded border p-2"><option value="">All statuses</option><option value="posted">Posted</option><option value="pending">Pending</option></select>
      <select name="kind" defaultValue={kind ?? ""} aria-label="Type" className="rounded border p-2"><option value="">All types</option><option value="ordinary">Ordinary</option><option value="transfer">Transfer</option><option value="refund">Refund</option></select>
      <select name="direction" defaultValue={direction ?? ""} aria-label="Direction" className="rounded border p-2"><option value="">Income and outflow</option><option value="income">Income</option><option value="outflow">Outflow</option></select>
      <button className="rounded border px-4">Filter</button>
    </form>
    {error ? <p role="alert" className="mt-6">Could not load transactions: {error.message}</p> : <TransactionTable rows={rows} accountNames={names} query={current.toString()} />}
    {next && <Link className="mt-5 inline-block underline" href={`/money/transactions?${new URLSearchParams({ ...Object.fromEntries(current), cursor: next })}`}>Next page</Link>}
    {selected && <aside aria-label="Transaction details" className="fixed inset-y-0 right-0 w-full max-w-md overflow-y-auto border-l bg-background p-6 shadow-xl">
      <Link href={`/money/transactions?${current}`} className="text-sm underline">Close</Link>
      <h2 className="mt-6 text-xl font-semibold">{selected.description}</h2>
      <p className="mt-2">{selected.posted_on} · {selected.amount_minor} minor units {selected.currency_code}</p>
      <dl className="mt-6 space-y-2 text-sm"><div><dt className="text-muted-foreground">Account</dt><dd>{names[selected.account_id]}</dd></div><div><dt className="text-muted-foreground">Status</dt><dd>{selected.status}</dd></div><div><dt className="text-muted-foreground">Type</dt><dd>{selected.kind}</dd></div><div><dt className="text-muted-foreground">Note</dt><dd>{selected.note || "—"}</dd></div></dl>
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
