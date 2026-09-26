import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { TransactionTable } from "./table";

type Filters = { q?: string; from?: string; to?: string; account?: string; cursor?: string; transaction?: string };

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
    .select("before, after, created_at").eq("workspace_id", workspace.id)
    .eq("transaction_id", selected.id).order("created_at", { ascending: false }) : { data: null };
  const names = Object.fromEntries((accounts ?? []).map(account => [account.id, account.name]));
  const current = new URLSearchParams();
  for (const key of ["q", "from", "to", "account", "cursor"] as const) if (params[key]) current.set(key, params[key]);

  return <main className="mx-auto max-w-6xl px-6 py-10">
    <header className="flex items-center justify-between"><div><Link href="/" className="text-sm text-muted-foreground">← Home</Link><h1 className="mt-2 text-3xl font-semibold">Transactions</h1></div><Link href="/import" className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground">Import</Link></header>
    <form className="mt-8 flex flex-wrap gap-3" method="get">
      <input name="q" defaultValue={params.q} placeholder="Search descriptions" aria-label="Search descriptions" className="rounded border p-2" />
      <input name="from" type="date" defaultValue={params.from} aria-label="From date" className="rounded border p-2" />
      <input name="to" type="date" defaultValue={params.to} aria-label="To date" className="rounded border p-2" />
      <select name="account" defaultValue={params.account ?? ""} aria-label="Account" className="rounded border p-2"><option value="">All accounts</option>{accounts?.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select>
      <button className="rounded border px-4">Filter</button>
    </form>
    {error ? <p role="alert" className="mt-6">Could not load transactions: {error.message}</p> : <TransactionTable rows={rows} accountNames={names} query={current.toString()} />}
    {next && <Link className="mt-5 inline-block underline" href={`/money/transactions?${new URLSearchParams({ ...Object.fromEntries(current), cursor: next })}`}>Next page</Link>}
    {selected && <aside aria-label="Transaction details" className="fixed inset-y-0 right-0 w-full max-w-md overflow-y-auto border-l bg-background p-6 shadow-xl">
      <Link href={`/money/transactions?${current}`} className="text-sm underline">Close</Link>
      <h2 className="mt-6 text-xl font-semibold">{selected.description}</h2>
      <p className="mt-2">{selected.posted_on} · {selected.amount_minor} minor units {selected.currency_code}</p>
      <dl className="mt-6 space-y-2 text-sm"><div><dt className="text-muted-foreground">Account</dt><dd>{names[selected.account_id]}</dd></div><div><dt className="text-muted-foreground">Status</dt><dd>{selected.status}</dd></div><div><dt className="text-muted-foreground">Type</dt><dd>{selected.kind}</dd></div><div><dt className="text-muted-foreground">Note</dt><dd>{selected.note || "—"}</dd></div></dl>
      <h3 className="mt-8 font-medium">Original source</h3><pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{JSON.stringify(sources ?? [], null, 2)}</pre>
      <h3 className="mt-8 font-medium">Correction history</h3><pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{JSON.stringify(history ?? [], null, 2)}</pre>
    </aside>}
  </main>;
}
