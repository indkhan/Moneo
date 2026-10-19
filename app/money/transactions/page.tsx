import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { formatMoney } from "@/lib/finance/format";
import { calendarDate } from "@/lib/finance/calendar";
import { createManualTransaction } from "./actions";
import { EditingHistory } from "./editing-history";
import { DEFAULT_SORT, SORT_ORDER, cursorClause, nextCursorForRow, parseTransactionParams, toQueryParams, toggleSort, type ParsedTransactionParams, type TransactionGroup } from "./filters";
import { invalidStoredViewScope, parseStoredFilters, parseViewId, savedViewToParams } from "../views/validate";
import { SavedViewsPanel } from "../views/panel";
import { FilterBar } from "./filter-bar";
import { LedgerTable, type LedgerRow } from "./ledger-table";
import { TransactionDrawer } from "./drawer";
import { kindLabel, statusLabel } from "./labels";
import { summarizeGroups, orderByGroup } from "./grouping";
import { ledgerTable, scopeLedger } from "./scope";

const PAGE_SIZE = 50;
// ponytail: subtotals scan at most this many matching rows (PostgREST max rows); an RPC aggregate lifts the cap if ledgers grow.
const GROUP_SCAN_LIMIT = 1000;
const GROUPS: { value: TransactionGroup | ""; label: string }[] = [{ value: "", label: "None" }, { value: "category", label: "Category" }, { value: "merchant", label: "Merchant" }, { value: "month", label: "Month" }];

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const params = await searchParams;
  // Opaque saved-view id (?view=<uuid>): filter JSON is loaded from
  // workspace-scoped storage, so search terms and ids never appear in the link.
  const viewId = parseViewId(params.view);
  const [{ data: accounts }, { data: categories }, { data: merchants }, { data: savedViews }, { data: viewRow }] = await Promise.all([
    supabase.from("accounts").select("id, name, currency_code, archived_at").eq("workspace_id", workspace.id).order("name"),
    supabase.from("categories").select("id, name").eq("workspace_id", workspace.id).order("name"),
    supabase.from("merchants").select("id, name").eq("workspace_id", workspace.id).order("name"),
    supabase.from("transaction_views").select("id, name, created_at, version").eq("workspace_id", workspace.id).is("removed_at", null).order("created_at", { ascending: false }).limit(50),
    viewId ? supabase.from("transaction_views").select("id, name, filters").eq("workspace_id", workspace.id).eq("id", viewId).is("removed_at", null).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const activeView = viewRow ? { id: viewRow.id as string, name: viewRow.name as string } : null;
  const viewRows = (savedViews ?? []).map(view => ({ id: view.id, name: view.name, created_at: view.created_at, version: view.version }));
  const header = <header className="flex flex-wrap items-end justify-between gap-4">
    <div><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand">Money</p><h1 className="mt-1 text-2xl font-semibold tracking-tight">Transactions</h1></div>
    <nav aria-label="Money sections" className="flex flex-wrap gap-1 text-sm">
      <Link href="/money/organization" className="rounded-lg px-3 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">Organize spending</Link>
      <Link href="/import" className="rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90">Import statement</Link>
    </nav>
  </header>;

  // An invalid persisted scope never reaches the ledger query: no rows or
  // results render under the saved-view title. Rename/delete stay available;
  // saving is disabled so the broadened scope cannot be re-saved.
  const scopeError = viewRow ? invalidStoredViewScope(viewRow.filters as unknown) : null;
  if (scopeError && activeView) {
    return <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 text-foreground sm:px-6">
      {header}
      <section aria-label="Invalid saved view" className="rounded-xl border border-border bg-card p-6">
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">{scopeError}</p>
        <p className="mt-2 text-sm text-muted-foreground">Set the tag and spending group with normal filters, save a corrected view, then delete this broken view below.</p>
        <Link className="mt-3 inline-block underline" href="/money/transactions">Back to normal filters</Link>
      </section>
      <SavedViewsPanel views={viewRows} activeViewId={activeView.id} activeViewName={activeView.name} saveDefaults={{}} disableSave />
    </main>;
  }

  const urlFilters = parseTransactionParams(params);
  let filters: ParsedTransactionParams = urlFilters;
  if (activeView) {
    const saved = savedViewToParams(parseStoredFilters(viewRow!.filters as unknown));
    // Only ephemeral navigation (cursor re-validated against the saved sort,
    // open transaction, grouping) comes from the URL in view mode.
    const { cursor } = parseTransactionParams({ cursor: params.cursor, sort: saved.sort });
    filters = { ...saved, ...(cursor ? { cursor } : {}), ...(urlFilters.transactionId ? { transactionId: urlFilters.transactionId } : {}), ...(urlFilters.group ? { group: urlFilters.group } : {}) };
  }
  const table = ledgerTable(filters);
  const { column, ascending } = SORT_ORDER[filters.sort];
  let query = scopeLedger(supabase.from(table).select("id, version, posted_on, description, amount_minor::text, currency_code, status, kind, account_id, category_id, merchant_id, tags, event_name, review_reasons", { count: "exact" })
    .eq("workspace_id", workspace.id), filters).order(column, { ascending }).order("id", { ascending }).limit(PAGE_SIZE + 1);
  if (filters.cursor) query = query.or(cursorClause(filters.sort, filters.cursor));
  const [{ data, error, count }, grouped] = await Promise.all([
    query,
    filters.group ? scopeLedger(supabase.from(table).select("category_id, merchant_id, posted_on, amount_minor::text, currency_code").eq("workspace_id", workspace.id), filters)
      .order("posted_on", { ascending: false }).order("id").limit(GROUP_SCAN_LIMIT) : Promise.resolve(null),
  ]);
  if (grouped?.error) throw grouped.error;
  const pageRows = (data ?? []).slice(0, PAGE_SIZE) as LedgerRow[];
  const next = data && data.length > PAGE_SIZE ? nextCursorForRow(pageRows[PAGE_SIZE - 1], filters.sort) : null;

  const accountNames = Object.fromEntries((accounts ?? []).map(account => [account.id, account.name]));
  const categoryNames = Object.fromEntries((categories ?? []).map(row => [row.id, row.name]));
  const merchantNames = Object.fromEntries((merchants ?? []).map(row => [row.id, row.name]));
  const monthName = (key: string) => new Date(`${key}-01T00:00:00Z`).toLocaleString(workspace.locale, { month: "long", year: "numeric", timeZone: "UTC" });
  const groups = filters.group && grouped?.data ? {
    by: filters.group,
    summaries: Object.fromEntries(summarizeGroups(grouped.data, filters.group)),
    labels: Object.fromEntries([...new Set(grouped.data.map(row => filters.group === "month" ? row.posted_on.slice(0, 7) : (filters.group === "category" ? row.category_id : row.merchant_id) ?? "none"))]
      .map(key => [key, filters.group === "month" ? monthName(key) : key === "none" ? (filters.group === "category" ? "Uncategorized" : "Unknown merchant") : (filters.group === "category" ? categoryNames : merchantNames)[key] ?? "Unknown"])),
  } : null;
  const rows = groups ? orderByGroup(pageRows, groups.by) : pageRows;

  // Shareable filter params (no cursor/open transaction). In view mode,
  // navigation keeps the opaque view link; sort headers and chip removal
  // open an ad-hoc filtered URL (same exposure as normal filtering).
  const shareable = toQueryParams({ ...filters, cursor: undefined, transactionId: undefined });
  const withParams = (base: URLSearchParams, changes: Record<string, string | null>) => {
    const out = new URLSearchParams(base);
    for (const [key, value] of Object.entries(changes)) if (value === null) out.delete(key); else out.set(key, value);
    return `/money/transactions${out.size ? `?${out}` : ""}`;
  };
  const viewBase = new URLSearchParams(activeView ? { view: activeView.id, ...(filters.group ? { group: filters.group } : {}) } : shareable);
  const current = new URLSearchParams(viewBase);
  if (filters.cursor) current.set("cursor", `${filters.cursor.value}|${filters.cursor.id}`);
  const sortHref = (columnName: "date" | "amount") => { const sort = toggleSort(filters.sort, columnName); return withParams(shareable, { sort: sort === DEFAULT_SORT ? null : sort }); };
  const saveDefaults = Object.fromEntries(toQueryParams({ ...filters, cursor: undefined, transactionId: undefined, group: undefined }));

  const amountCurrency = (accounts ?? []).find(row => row.id === filters.accountId)?.currency_code ?? workspace.display_currency;
  const chips: [string, string][] = [
    ["q", filters.q && `“${filters.q}”`], ["from", filters.from && `From ${filters.from}`], ["to", filters.to && `To ${filters.to}`],
    ["account", filters.accountId && (accountNames[filters.accountId] ?? "Account")],
    ["category", filters.uncategorized ? "Uncategorized" : filters.categoryId && (categoryNames[filters.categoryId] ?? "Category")],
    ["merchant", filters.merchantUnknown ? "Unknown merchant" : filters.merchantId && (merchantNames[filters.merchantId] ?? "Merchant")],
    ["minAmount", filters.minAmountMinor !== undefined && `At least ${formatMoney(filters.minAmountMinor, amountCurrency, workspace.locale)}`],
    ["maxAmount", filters.maxAmountMinor !== undefined && `At most ${formatMoney(filters.maxAmountMinor, amountCurrency, workspace.locale)}`],
    ["direction", filters.direction && (filters.direction === "income" ? "Money in" : "Money out")],
    ["status", filters.status && statusLabel(filters.status)], ["kind", filters.kind && kindLabel(filters.kind)],
    ["tag", filters.tag && `Tag: ${filters.tag}`], ["event", filters.eventName && `Group: ${filters.eventName}`],
  ].filter((chip): chip is [string, string] => typeof chip[1] === "string" && chip[1] !== "");
  const filterValues = Object.fromEntries(shareable);
  const activeAccounts = (accounts ?? []).filter(account => !account.archived_at);

  return <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 text-foreground sm:px-6">
    {header}
    {viewId && !activeView ? <p role="alert" className="text-sm">Saved view not found. Showing normal filters.</p> : null}
    <div className="grid gap-6">
      <aside className="order-2 space-y-6">
        <SavedViewsPanel views={viewRows} activeViewId={activeView?.id ?? null} activeViewName={activeView?.name ?? null} saveDefaults={saveDefaults} />
      </aside>
      <div className="order-1 min-w-0 space-y-4">
        <FilterBar key={shareable.toString()} values={filterValues} accounts={accounts ?? []} categories={categories ?? []} merchants={merchants ?? []} displayCurrency={workspace.display_currency} timezone={workspace.timezone} />
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <ul aria-label="Active filters" className="flex flex-wrap items-center gap-1.5">
            {activeView ? <li className="rounded-full bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand">View: {activeView.name}</li> : null}
            {chips.map(([key, label]) => <li key={key}><Link href={withParams(shareable, { [key]: null })} scroll={false} aria-label={`Remove filter ${label}`} className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs hover:bg-muted">{label}<span aria-hidden>×</span></Link></li>)}
            {chips.length ? <li><Link href="/money/transactions" className="px-1 text-xs text-muted-foreground underline">Clear all</Link></li> : null}
          </ul>
          <div className="flex items-center gap-3">
            {count !== null ? <span className="font-mono text-xs text-muted-foreground">{filters.cursor ? `${count.toLocaleString(workspace.locale)} from here` : `${count.toLocaleString(workspace.locale)} ${count === 1 ? "transaction" : "transactions"}`}</span> : null}
            <nav aria-label="Group by" className="flex items-center gap-1 text-xs"><span className="text-muted-foreground">Group</span>
              {GROUPS.map(option => <Link key={option.value} scroll={false} aria-current={(filters.group ?? "") === option.value ? "true" : undefined}
                href={withParams(viewBase, { group: option.value || null, cursor: null })}
                className={`rounded-md px-2 py-1 ${(filters.group ?? "") === option.value ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted"}`}>{option.label}</Link>)}
            </nav>
          </div>
        </div>
        {groups && (groups.by === "category" || (grouped?.data && count !== null && count > grouped.data.length)) ? <p className="text-xs text-muted-foreground">
          {grouped?.data && count !== null && count > grouped.data.length ? `Subtotals cover the ${grouped.data.length.toLocaleString(workspace.locale)} most recent matches; narrow the dates for complete totals. ` : ""}
          {groups.by === "category" ? "Split transactions are grouped under their original category." : ""}</p> : null}
        {error ? <p role="alert">Could not load transactions: {error.message}</p> : <LedgerTable rows={rows} accountNames={accountNames} categories={categories ?? []} merchants={merchants ?? []}
          query={current.toString()} sort={filters.sort} sortHrefs={{ date: sortHref("date"), amount: sortHref("amount") }} groups={groups} openId={filters.transactionId ?? null}
          closeHref={`/money/transactions${current.size ? `?${current}` : ""}`} locale={workspace.locale} requestId={crypto.randomUUID()} />}
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {filters.cursor ? <Link className="underline" href={withParams(viewBase, {})}>First page</Link> : null}
          {next ? <Link className="underline" href={withParams(viewBase, { cursor: next })}>Next page</Link> : null}
          <p className="ml-auto hidden text-xs text-muted-foreground sm:block"><kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open · <kbd>x</kbd> select · <kbd>/</kbd> search · <kbd>Esc</kbd> close</p>
        </div>
        <details className="rounded-xl border border-border bg-card p-4">
          <summary className="cursor-pointer text-sm font-semibold">Add a manual transaction</summary>
          {!activeAccounts.length ? <p className="mt-3 text-sm text-muted-foreground">Add or restore an active account before entering a transaction.</p> : <form action={createManualTransaction} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 [&_input]:min-h-10 [&_input]:rounded-lg [&_input]:border [&_input]:border-border [&_input]:bg-card [&_input]:px-3 [&_input]:text-sm [&_select]:min-h-10 [&_select]:rounded-lg [&_select]:border [&_select]:border-border [&_select]:bg-card [&_select]:px-3 [&_select]:text-sm">
            <input type="hidden" name="requestId" value={crypto.randomUUID()} />
            <label className="grid gap-1 text-sm">Account<select name="accountId" required>{activeAccounts.map(account => <option key={account.id} value={account.id}>{account.name} ({account.currency_code})</option>)}</select></label>
            <label className="grid gap-1 text-sm">Posting date<input name="postedOn" type="date" required defaultValue={calendarDate(new Date(), workspace.timezone)} /></label>
            <label className="grid gap-1 text-sm">Description<input name="description" required maxLength={500} /></label>
            <label className="grid gap-1 text-sm">Signed decimal amount<input name="amount" required maxLength={30} inputMode="decimal" placeholder="-12.34" /><span className="text-xs text-muted-foreground">Use a minus sign for spending, e.g. -12.34.</span></label>
            <label className="grid gap-1 text-sm">Status<select name="status" defaultValue="posted"><option value="posted">Posted</option><option value="pending">Pending</option></select></label>
            <label className="grid gap-1 text-sm">Category<select name="categoryId"><option value="">Uncategorized</option>{categories?.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label className="grid gap-1 text-sm">Note<input name="note" maxLength={2000} /></label>
            <button className="min-h-10 self-end rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white">Add transaction</button>
          </form>}
        </details>
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading batch history…</p>}>
          <EditingHistory query={current.toString()} names={{ categories: categoryNames, merchants: merchantNames }} />
        </Suspense>
      </div>
    </div>
    {filters.transactionId ? <Suspense key={filters.transactionId} fallback={<aside aria-label="Loading transaction" className="fixed inset-y-0 right-0 z-50 w-full max-w-lg border-l border-border bg-card p-6 shadow-2xl"><p className="text-sm text-muted-foreground">Loading…</p></aside>}>
      <TransactionDrawer id={filters.transactionId} query={current.toString()} linkSearch={params.linkSearch?.trim().slice(0, 200) ?? ""} accountNames={accountNames} categories={categories ?? []} merchants={merchants ?? []} />
    </Suspense> : null}
  </main>;
}
