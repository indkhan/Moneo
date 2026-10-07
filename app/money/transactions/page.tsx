import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { TransactionTable } from "./table";
import { correctTransaction, undoCorrection, markRefund, clearLink, undoVerifiedLink, createManualTransaction, undoTransactionSplits } from "./actions";
import { SplitEditor } from "./split-editor";
import { VerifiedLinkEditor, type LinkPosting } from "./verified-link-editor";
import { formatMoney as formatCurrency } from "@/lib/finance/format";
import { BulkEditor } from "./bulk-editor";
import { EditingHistory } from "./editing-history";
import { calendarDate } from "@/lib/finance/calendar";
import { DEFAULT_SORT, SORT_ORDER, cursorClause, nextCursorForRow, parseTransactionParams, toQueryParams, type ParsedTransactionParams } from "./filters";
import { invalidStoredViewScope, normalizeEventName, normalizeTag, parseStoredFilters, parseViewId, type SaveInput } from "../views/validate";
import { SavedViewsPanel } from "../views/panel";
import { PendingHoldPanel } from "./pending-hold-panel";

type Filters = { linkSearch?: string; q?: string; from?: string; to?: string; account?: string; status?: string; kind?: string; direction?: string; category?: string; merchant?: string; minAmount?: string; maxAmount?: string; sort?: string; cursor?: string; transaction?: string; view?: string; tag?: string; event?: string };

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Filters> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const formatMoney=(amount:Parameters<typeof formatCurrency>[0],currency:string)=>formatCurrency(amount,currency,workspace.locale);
  const params = await searchParams;
  // Opaque saved-view id (?view=<uuid>). When present the filter JSON is
  // loaded server-side from workspace-scoped storage, so search terms and
  // account/category/merchant ids never appear in the saved-view link.
  const viewId = parseViewId(typeof params.view === "string" ? params.view : undefined);
  const [{ data: accounts }, { data: categories }, { data: merchants }, { data: savedViews }] = await Promise.all([
    supabase.from("accounts").select("id, name, currency_code, archived_at")
      .eq("workspace_id", workspace.id).order("name"),
    supabase.from("categories").select("id, name")
      .eq("workspace_id", workspace.id).order("name"),
    supabase.from("merchants").select("id, name")
      .eq("workspace_id", workspace.id).order("name"),
    supabase.from("transaction_views").select("id, name, created_at, version")
      .eq("workspace_id", workspace.id).is("removed_at", null).order("created_at", { ascending: false }).limit(50),
  ]);
  let activeView: { id: string; name: string } | null = null;
  let savedFilters = null as ReturnType<typeof parseStoredFilters> | null;
  let savedViewScopeError: string | null = null;
  let viewNotFound = false;
  if (viewId) {
    const { data } = await supabase.from("transaction_views")
      .select("id, name, filters").eq("workspace_id", workspace.id).eq("id", viewId).is("removed_at", null).maybeSingle();
    if (!data) viewNotFound = true;
    else {
      activeView = { id: data.id, name: data.name };
      savedViewScopeError = invalidStoredViewScope(data.filters as unknown);
      savedFilters = parseStoredFilters(data.filters as unknown);
    }
  }
  const pageHeader = (<header className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand">Money / Ledger</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">Transactions</h1><p className="mt-1 text-sm text-muted-foreground">Search, review, and correct your ledger.</p></div><div className="flex flex-wrap gap-2"><Link href="/money/accounts" className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium hover:bg-muted">Accounts</Link><Link href="/money/wealth" className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium hover:bg-muted">Investments, assets and debts</Link><Link href="/money/recurring" className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium hover:bg-muted">Review recurring</Link><Link href="/import" className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90">Import statement</Link></div></header>);
  const viewRows = (savedViews ?? []).map(view => ({ id: view.id, name: view.name, created_at: view.created_at, version: view.version }));

  // An invalid persisted scope never reaches the ledger query: no rows or
  // financial results render under the saved-view title. The panel below
  // keeps rename/delete so the broken view can be removed; saving is
  // disabled so the broadened scope cannot be re-saved.
  if (savedViewScopeError && activeView) {
    return <main className="mx-auto max-w-[1600px] space-y-6 px-4 py-6 text-foreground sm:px-8">
      {pageHeader}
      <section aria-label="Invalid saved view" className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">{savedViewScopeError}</p>
        <p className="mt-2 text-sm text-muted-foreground">Set the tag and spending group with normal filters, save a corrected view, then delete this broken view below.</p>
        <Link className="mt-3 inline-block underline" href="/money/transactions">Back to normal filters</Link>
      </section>
      <SavedViewsPanel views={viewRows} activeViewId={activeView.id} activeViewName={activeView.name} saveDefaults={{}} disableSave />
    </main>;
  }

  const urlFilters = parseTransactionParams(params as Record<string, string | undefined>);
  const urlMerchantRaw = typeof params.merchant === "string" ? params.merchant : undefined;
  const urlMerchantId = urlMerchantRaw && /^[0-9a-f-]{36}$/i.test(urlMerchantRaw) ? urlMerchantRaw : undefined;
  const urlMerchantUnknown = urlMerchantRaw === "none";
  // Effective filters: saved JSON in view mode, validated URL params otherwise.
  // Normal filtering keeps working unchanged when no ?view= is present.
  let filters: ParsedTransactionParams = urlFilters;
  let merchantId = urlMerchantId;
  let merchantUnknown = urlMerchantUnknown;
  if (activeView && savedFilters) {
    const sort = savedFilters.sort ?? DEFAULT_SORT;
    // Cursor/transaction stay in the URL (ephemeral navigation state only);
    // every other URL filter param is ignored so the view link stays opaque.
    // The cursor is re-validated against the saved sort, not the URL sort.
    const cursorHolder = parseTransactionParams({ cursor: params.cursor, sort });
    filters = {
      ...(savedFilters.q ? { q: savedFilters.q } : {}),
      ...(savedFilters.from ? { from: savedFilters.from } : {}),
      ...(savedFilters.to ? { to: savedFilters.to } : {}),
      ...(savedFilters.accountId ? { accountId: savedFilters.accountId } : {}),
      ...(savedFilters.status ? { status: savedFilters.status } : {}),
      ...(savedFilters.kind ? { kind: savedFilters.kind } : {}),
      ...(savedFilters.direction ? { direction: savedFilters.direction } : {}),
      ...(savedFilters.categoryId ? { categoryId: savedFilters.categoryId } : {}),
      ...(savedFilters.uncategorized ? { uncategorized: true } : {}),
      ...(savedFilters.minAmountMinor !== undefined ? { minAmountMinor: savedFilters.minAmountMinor } : {}),
      ...(savedFilters.maxAmountMinor !== undefined ? { maxAmountMinor: savedFilters.maxAmountMinor } : {}),
      sort,
      ...(cursorHolder.cursor ? { cursor: cursorHolder.cursor } : {}),
      ...(urlFilters.transactionId ? { transactionId: urlFilters.transactionId } : {}),
    };
    merchantId = savedFilters.merchantId;
    merchantUnknown = savedFilters.merchantUnknown ?? false;
  }
  const { column, ascending } = SORT_ORDER[filters.sort];
  let query = supabase.from(filters.categoryId || filters.uncategorized ? "transaction_category_ledger" : "transactions")
    .select("id, posted_on, description, amount_minor::text, currency_code, status, kind, account_id, category_id, merchant_id, note, version, tags, event_name, review_reasons")
    .eq("workspace_id", workspace.id).order(column, { ascending }).order("id", { ascending }).limit(51);
  if (filters.q) query = query.ilike("description", `%${filters.q.replace(/[%_]/g, "\\$&")}%`);
  const urlTag = normalizeTag(typeof params.tag === "string" ? params.tag : undefined) ?? "";
  const urlEventName = normalizeEventName(typeof params.event === "string" ? params.event : undefined) ?? "";
  // In view mode the opaque link carries no filter params, so the scope
  // comes from saved JSON; otherwise the live URL params apply unchanged.
  const tag = activeView && savedFilters ? (savedFilters.tag ?? "") : urlTag;
  const eventName = activeView && savedFilters ? (savedFilters.eventName ?? "") : urlEventName;
  if (tag) query = query.contains("tags", [tag]);
  if (eventName) query = query.eq("event_name", eventName);
  if (filters.from) query = query.gte("posted_on", filters.from);
  if (filters.to) query = query.lte("posted_on", filters.to);
  if (filters.accountId) query = query.eq("account_id", filters.accountId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.kind) query = query.eq("kind", filters.kind);
  if (filters.direction === "income") query = query.gt("amount_minor", 0);
  else if (filters.direction === "outflow") query = query.lt("amount_minor", 0);
  if (filters.categoryId) query = query.eq("category_id", filters.categoryId);
  else if (filters.uncategorized) query = query.is("category_id", null);
  if (merchantId) query = query.eq("merchant_id", merchantId);
  else if (merchantUnknown) query = query.is("merchant_id", null);
  if (filters.minAmountMinor !== undefined) query = query.gte("amount_minor", filters.minAmountMinor);
  if (filters.maxAmountMinor !== undefined) query = query.lte("amount_minor", filters.maxAmountMinor);
  if (filters.cursor) query = query.or(cursorClause(filters.sort, filters.cursor));
  const { data, error } = await query;
  const rows = data?.slice(0, 50) ?? [];
  const next = data && data.length > 50 && rows.length === 50
    ? nextCursorForRow(rows[49] as { posted_on: string; amount_minor: string; id: string }, filters.sort)
    : null;
  const { data: selected } = filters.transactionId ? await supabase.from("transactions")
    .select("*, amount_minor::text").eq("workspace_id", workspace.id).eq("id", filters.transactionId).maybeSingle() : { data: null };
  const { data: sources } = selected ? await supabase.from("transaction_sources")
    .select("source_transactions(original_row, fee_evidence, import_id, row_number)")
    .eq("transaction_id", selected.id) : { data: null };
  const { data: manualSource } = selected ? await supabase.from("manual_transaction_entries").select("original_record, created_at")
    .eq("workspace_id", workspace.id).eq("transaction_id", selected.id).maybeSingle() : { data: null };
  const splitSet = selected ? await supabase.from("transaction_split_sets").select("id").eq("workspace_id", workspace.id)
    .eq("transaction_id", selected.id).is("undone_at", null).maybeSingle() : { data: null, error: null };
  if (splitSet.error) throw splitSet.error;
  const splitRows = splitSet.data ? await supabase.from("transaction_splits").select("id, amount_minor::text, category_id, note, ordinal")
    .eq("workspace_id", workspace.id).eq("split_set_id", splitSet.data.id).order("ordinal") : { data: null, error: null };
  if (splitRows.error) throw splitRows.error;
  const { data: history } = selected ? await supabase.from("correction_events")
    .select("id, before, after, undone, created_at").eq("workspace_id", workspace.id)
    .eq("transaction_id", selected.id).order("created_at", { ascending: false }) : { data: null };
  const { data: category } = selected?.category_id ? await supabase.from("categories")
    .select("name").eq("workspace_id", workspace.id).eq("id", selected.category_id).maybeSingle() : { data: null };
  const { data: selectedMerchant } = selected?.merchant_id ? await supabase.from("merchants")
    .select("name").eq("workspace_id", workspace.id).eq("id", selected.merchant_id).maybeSingle() : { data: null };
  const selectedAmount = (() => { try { return BigInt(selected?.amount_minor ?? ""); } catch { return null; } })();
  const { data: counterpart } = selected?.transfer_id ? await supabase.from("transactions")
    .select("id, description, posted_on, amount_minor::text, currency_code, account_id, kind, status, version")
    .eq("workspace_id", workspace.id).eq("id", selected.transfer_id).maybeSingle() : { data: null };
  const { data: refundOriginal } = selected?.refund_of_id ? await supabase.from("transactions")
    .select("id, description, posted_on, amount_minor::text, currency_code, account_id, kind, status, version")
    .eq("workspace_id", workspace.id).eq("id", selected.refund_of_id).maybeSingle() : { data: null };
  const { data: inboundRefunds } = selected ? await supabase.from("transactions")
    .select("id, description, posted_on, amount_minor::text, currency_code")
    .eq("workspace_id", workspace.id).eq("refund_of_id", selected.id)
    .order("posted_on", { ascending: false }).limit(10) : { data: null };
  const { data: inboundTransfer } = selected ? await supabase.from("transactions")
    .select("id, description, posted_on, amount_minor::text, currency_code, account_id, kind")
    .eq("workspace_id", workspace.id).eq("transfer_id", selected.id).limit(5) : { data: null };
  const receipt = selected ? await supabase.from("transaction_links").select("id, operation, fx_evidence, original_equivalent_minor::text").eq("workspace_id",workspace.id).is("undone_at",null)
    .or(`primary_transaction_id.eq.${selected.id},and(operation.eq.transfer,counterpart_transaction_id.eq.${selected.id})`).maybeSingle() : {data:null,error:null};
  if(receipt.error) throw receipt.error;
  const fees=receipt.data ? await supabase.from("transaction_link_fees").select("transaction_id, fee_minor::text, treatment, category_id, note").eq("workspace_id",workspace.id).eq("link_id",receipt.data.id) : {data:null,error:null};
  if(fees.error) throw fees.error;
  const rates=selected ? await supabase.from("fx_rates").select("id, from_currency, to_currency, rate_text, rate_date, source").eq("workspace_id",workspace.id).order("rate_date",{ascending:false}).limit(100) : {data:[],error:null};
  if(rates.error) throw rates.error;
  const linkSearch=typeof params.linkSearch==="string"?params.linkSearch.trim().slice(0,200):"";
  let transferCandidates:LinkPosting[]=[]; let refundCandidates:LinkPosting[]=[];
  if(selected && selected.status==="posted" && selected.kind==="ordinary" && !receipt.data && selectedAmount!==null) {
    let query=supabase.from("transactions").select("id, version, description, posted_on, amount_minor::text, currency_code").eq("workspace_id",workspace.id).neq("id",selected.id).neq("account_id",selected.account_id).eq("status","posted").eq("kind","ordinary").is("transfer_id",null).is("refund_of_id",null);
    query=selectedAmount<0n?query.gt("amount_minor",0):query.lt("amount_minor",0);
    if(linkSearch) query=query.ilike("description",`%${linkSearch.replace(/[%_]/g,"\\$&")}%`);
    const result=await query.order("posted_on",{ascending:false}).order("id").limit(100); if(result.error) throw result.error; transferCandidates=result.data??[];
  }
  if(selected && selected.status==="posted" && ["ordinary","refund"].includes(selected.kind) && !receipt.data && !selected.refund_of_id && selectedAmount!==null && selectedAmount>0n) {
    let originalQuery=supabase.from("transactions").select("id, version, description, posted_on, amount_minor::text, currency_code").eq("workspace_id",workspace.id).neq("id",selected.id).eq("kind","ordinary").eq("status","posted").eq("review_reasons","{}").is("transfer_id",null).is("refund_of_id",null).lte("posted_on",selected.posted_on).lt("amount_minor",0);
    if(linkSearch) originalQuery=originalQuery.ilike("description",`%${linkSearch.replace(/[%_]/g,"\\$&")}%`);
    const result=await originalQuery.order("posted_on",{ascending:false}).order("id").limit(100);
    if(result.error) throw result.error; refundCandidates=result.data??[];
  }
  const names = Object.fromEntries((accounts ?? []).map(account => [account.id, account.name]));
  const merchantNames = Object.fromEntries((merchants ?? []).map(merchant => [merchant.id, merchant.name]));
  // Navigation params. In view mode detail/pagination links stay opaque
  // (?view=<uuid>&cursor=…&transaction=…); sort headers use the serialized
  // saved filters so the existing table toggle keeps working, which opens
  // an ad-hoc filtered URL (same exposure as normal filtering).
  let current: URLSearchParams;
  let baseQuery: string;
  let nextParams: URLSearchParams;
  let saveDefaults: SaveInput;
  if (activeView) {
    current = new URLSearchParams();
    current.set("view", activeView.id);
    if (filters.cursor) current.set("cursor", `${filters.cursor.value}|${filters.cursor.id}`);
    const serialized = toQueryParams({ ...filters, cursor: undefined, transactionId: undefined });
    serialized.delete("cursor");
    baseQuery = serialized.toString();
    nextParams = new URLSearchParams();
    nextParams.set("view", activeView.id);
    if (next) nextParams.set("cursor", next);
    saveDefaults = {
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
      ...(filters.accountId ? { account: filters.accountId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.direction ? { direction: filters.direction } : {}),
      ...(filters.uncategorized ? { category: "none" } : filters.categoryId ? { category: filters.categoryId } : {}),
      ...(merchantUnknown ? { merchant: "none" } : merchantId ? { merchant: merchantId } : {}),
      ...(tag ? { tag } : {}),
      ...(eventName ? { event: eventName } : {}),
      ...(filters.minAmountMinor !== undefined ? { minAmount: filters.minAmountMinor } : {}),
      ...(filters.maxAmountMinor !== undefined ? { maxAmount: filters.maxAmountMinor } : {}),
      ...(filters.sort !== DEFAULT_SORT ? { sort: filters.sort } : {}),
    };
  } else {
    current = toQueryParams(filters, { includeCursor: true });
    if (merchantId) current.set("merchant", merchantId);
    else if (merchantUnknown) current.set("merchant", "none");
    const baseParams = toQueryParams(filters);
    if (merchantId) baseParams.set("merchant", merchantId);
    else if (merchantUnknown) baseParams.set("merchant", "none");
    baseQuery = baseParams.toString();
    nextParams = toQueryParams(filters);
    if (merchantId) nextParams.set("merchant", merchantId);
    else if (merchantUnknown) nextParams.set("merchant", "none");
    if (next) nextParams.set("cursor", next);
    saveDefaults = {
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
      ...(filters.accountId ? { account: filters.accountId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.direction ? { direction: filters.direction } : {}),
      ...(filters.uncategorized ? { category: "none" } : filters.categoryId ? { category: filters.categoryId } : {}),
      ...(merchantUnknown ? { merchant: "none" } : merchantId ? { merchant: merchantId } : {}),
      ...(tag ? { tag } : {}),
      ...(eventName ? { event: eventName } : {}),
      ...(filters.minAmountMinor !== undefined ? { minAmount: filters.minAmountMinor } : {}),
      ...(filters.maxAmountMinor !== undefined ? { maxAmount: filters.maxAmountMinor } : {}),
      ...(filters.sort !== DEFAULT_SORT ? { sort: filters.sort } : {}),
    };
  }

  for (const navigation of [current, nextParams]) {
    if (tag) navigation.set("tag", tag);
    if (eventName) navigation.set("event", eventName);
  }
  if (tag || eventName) {
    const sortParams = new URLSearchParams(baseQuery);
    if (tag) sortParams.set("tag", tag);
    if (eventName) sortParams.set("event", eventName);
    baseQuery = sortParams.toString();
  }

  return <main className="mx-auto max-w-[1600px] space-y-6 px-4 py-6 text-foreground sm:px-8">
    {pageHeader}
    {viewNotFound ? <p role="alert" className="mt-6">Saved view not found. Showing normal filters.</p> : null}
    <details className="rounded-xl border border-border bg-card p-4">
      <summary className="cursor-pointer text-sm font-semibold">Add a manual transaction</summary>
      {!accounts?.some(account => !account.archived_at) ? <p className="mt-3 text-sm text-muted-foreground">Add or restore an active account before entering a transaction.</p> : <form action={createManualTransaction} className="mt-4 flex flex-wrap items-end gap-3">
        <input type="hidden" name="requestId" value={crypto.randomUUID()} />
        <label className="grid gap-1 text-sm">Account<select name="accountId" required className="rounded-lg border bg-card p-2">{accounts.filter(account => !account.archived_at).map(account => <option key={account.id} value={account.id}>{account.name} ({account.currency_code})</option>)}</select></label>
        <label className="grid gap-1 text-sm">Posting date<input name="postedOn" type="date" required defaultValue={calendarDate(new Date(), workspace.timezone)} className="rounded-lg border bg-card p-2" /></label>
        <label className="grid gap-1 text-sm">Description<input name="description" required maxLength={500} className="rounded-lg border bg-card p-2" /></label>
        <label className="grid gap-1 text-sm">Signed decimal amount<input name="amount" required maxLength={30} inputMode="decimal" placeholder="-12.34" className="w-36 rounded-lg border bg-card p-2" /><span className="text-xs text-muted-foreground">Expenses negative; decimal dot, no grouping.</span></label>
        <label className="grid gap-1 text-sm">Status<select name="status" defaultValue="posted" className="rounded-lg border bg-card p-2"><option value="posted">Posted</option><option value="pending">Pending</option></select></label>
        <label className="grid gap-1 text-sm">Category<select name="categoryId" className="rounded-lg border bg-card p-2"><option value="">Uncategorized</option>{categories?.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label className="grid gap-1 text-sm">Note<input name="note" maxLength={2000} className="rounded-lg border bg-card p-2" /></label>
        <button className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white">Add transaction</button>
      </form>}
    </details>
    <form className="flex flex-wrap items-center gap-2.5 rounded-xl border border-border bg-card p-4 shadow-sm [&_input]:rounded-lg [&_input]:border-border [&_input]:bg-card [&_input]:px-3 [&_input]:py-2 [&_input]:text-xs [&_select]:rounded-lg [&_select]:border-border [&_select]:bg-card [&_select]:px-3 [&_select]:py-2 [&_select]:text-xs" method="get">
      <input name="q" defaultValue={filters.q} placeholder="Search descriptions" aria-label="Search descriptions" className="rounded border p-2" />
      <input name="tag" defaultValue={tag} placeholder="Tag" aria-label="Filter by tag" maxLength={40} className="rounded border p-2" />
      <input name="event" defaultValue={eventName} placeholder="Trip / event group" aria-label="Filter by spending group" maxLength={120} className="rounded border p-2" />
      <input name="from" type="date" defaultValue={filters.from} aria-label="From date" className="rounded border p-2" />
      <input name="to" type="date" defaultValue={filters.to} aria-label="To date" className="rounded border p-2" />
      <select name="account" defaultValue={filters.accountId ?? ""} aria-label="Account" className="rounded border p-2"><option value="">All accounts</option>{accounts?.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select>
      <select name="category" defaultValue={filters.uncategorized ? "none" : filters.categoryId ?? ""} aria-label="Category" className="rounded border p-2"><option value="">All categories</option><option value="none">Uncategorized</option>{categories?.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
      <select name="merchant" defaultValue={merchantUnknown ? "none" : merchantId ?? ""} aria-label="Merchant" className="rounded border p-2"><option value="">All merchants</option><option value="none">Unknown</option>{merchants?.map(merchant => <option key={merchant.id} value={merchant.id}>{merchant.name}</option>)}</select>
      <input name="minAmount" defaultValue={filters.minAmountMinor} placeholder="Min (minor units)" aria-label="Minimum amount in minor units" inputMode="numeric" pattern="-?[0-9]+" title="Exact amount in minor units, e.g. cents (no decimals)" className="w-36 rounded border p-2" />
      <input name="maxAmount" defaultValue={filters.maxAmountMinor} placeholder="Max (minor units)" aria-label="Maximum amount in minor units" inputMode="numeric" pattern="-?[0-9]+" title="Exact amount in minor units, e.g. cents (no decimals)" className="w-36 rounded border p-2" />
      <select name="status" defaultValue={filters.status ?? ""} aria-label="Status" className="rounded border p-2"><option value="">All statuses</option><option value="posted">Posted</option><option value="pending">Pending</option></select>
      <select name="kind" defaultValue={filters.kind ?? ""} aria-label="Type" className="rounded border p-2"><option value="">All types</option><option value="ordinary">Ordinary</option><option value="transfer">Transfer</option><option value="refund">Refund</option></select>
      <select name="direction" defaultValue={filters.direction ?? ""} aria-label="Direction" className="rounded border p-2"><option value="">Income and outflow</option><option value="income">Income</option><option value="outflow">Outflow</option></select>
      <select name="sort" defaultValue={filters.sort} aria-label="Sort order" className="rounded border p-2"><option value="date-desc">Newest first</option><option value="date-asc">Oldest first</option><option value="amount-desc">Largest amount first</option><option value="amount-asc">Smallest amount first</option></select>
      <button className="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90">Apply filters</button>
    </form>
    <SavedViewsPanel views={viewRows} activeViewId={activeView?.id ?? null} activeViewName={activeView?.name ?? null} saveDefaults={saveDefaults} />
    {!!rows.length && <BulkEditor locale={workspace.locale} rows={rows} categories={categories ?? []} query={current.toString()} requestId={crypto.randomUUID()} />}
    {error ? <p role="alert" className="mt-6">Could not load transactions: {error.message}</p> : <TransactionTable locale={workspace.locale} rows={rows} accountNames={names} merchantNames={merchantNames} query={current.toString()} sort={filters.sort} baseQuery={baseQuery} />}
    {next && <Link className="mt-5 inline-block underline" href={`/money/transactions?${nextParams}`}>Next page</Link>}
    <EditingHistory query={current.toString()} />
    {selected && <aside aria-label="Transaction details" className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l border-border bg-card p-6 shadow-2xl [&_input:not([type=hidden])]:border-border [&_select]:border-border [&_textarea]:border-border">
      {selected.status === "pending" && selected.kind === "ordinary" && BigInt(selected.amount_minor) < 0n && <PendingHoldPanel transaction={selected} />}
      <Link href={`/money/transactions?${current}`} className="text-sm underline">Close</Link>
      <h2 className="mt-6 text-xl font-semibold">{selected.description}</h2>
      <p className="mt-2">{selected.posted_on} · {selected.amount_minor} minor units {selected.currency_code}</p>
      <p className="mt-2 text-sm">Tags: {(selected.tags ?? []).join(", ") || "None"} · Group: {selected.event_name || "None"}</p>
      {splitSet.data ? <section aria-label="Split allocations" className="mt-4 rounded border p-3"><h3 className="font-medium">Split allocations</h3><p className="mt-1 text-xs text-muted-foreground">The original amount, source and category are retained. Balances count the original once; spending uses these allocations. Undo splits before changing category or linking transfers/refunds.</p><ul className="mt-2 text-sm">{splitRows.data?.map(row => <li key={row.id}>{formatMoney(row.amount_minor, selected.currency_code)} · {categories?.find(category => category.id === row.category_id)?.name ?? "Uncategorized"} · {row.note}</li>)}</ul><form action={undoTransactionSplits} className="mt-3"><input type="hidden" name="setId" value={splitSet.data.id} /><input type="hidden" name="id" value={selected.id} /><input type="hidden" name="version" value={selected.version} /><input type="hidden" name="query" value={current.toString()} /><button className="text-sm underline">Undo splits</button></form></section> : selected.kind === "ordinary" && selected.status === "posted" && !selected.review_reasons?.length && !selected.transfer_id && !selected.refund_of_id && !inboundRefunds?.length && !inboundTransfer?.length && <SplitEditor locale={workspace.locale} id={selected.id} version={selected.version} amountMinor={selected.amount_minor} currency={selected.currency_code} categories={categories ?? []} query={current.toString()} requestId={crypto.randomUUID()} />}
      {!!selected.review_reasons?.length && <div role="alert" className="mt-3 text-sm text-amber-700 dark:text-amber-300"><p>Classification review needed: {selected.review_reasons.join(", ")}. Review the original import before relying on this entry’s spending classification.</p>
        {(sources ?? []).flatMap((source) => {
          const originals = Array.isArray(source.source_transactions) ? source.source_transactions : [source.source_transactions];
          return originals.filter(Boolean).map((original) => <Link key={`${original.import_id}-${original.row_number}`} href={`/import/${original.import_id}/review`} className="mr-3 underline">Review import row {original.row_number}</Link>);
        })}</div>}
      <dl className="mt-6 space-y-2 text-sm"><div><dt className="text-muted-foreground">Account</dt><dd>{names[selected.account_id]}</dd></div><div><dt className="text-muted-foreground">Merchant</dt><dd>{selectedMerchant?.name ?? "Unknown"}</dd></div><div><dt className="text-muted-foreground">Status</dt><dd>{selected.status}</dd></div><div><dt className="text-muted-foreground">Type</dt><dd>{selected.kind}</dd></div><div><dt className="text-muted-foreground">Note</dt><dd>{selected.note || "—"}</dd></div></dl>
      <section aria-label="Transfer or refund" className="mt-6 space-y-3 border-t pt-5">
        <h3 className="font-medium">Transfer / refund</h3>
        <p className="text-sm text-muted-foreground">Transfers are excluded from income and spending. Refunds reduce spending in the refund posting period. Markings are audited and can be undone from the history below.</p>
        {counterpart && <p className="text-sm">Transfer pair: <Link className="underline" href={`/money/transactions?${current.toString()}${current.toString() ? "&" : ""}transaction=${counterpart.id}`}>{counterpart.description} · {counterpart.posted_on}</Link></p>}
        {refundOriginal && <p className="text-sm">Refund of: <Link className="underline" href={`/money/transactions?${current.toString()}${current.toString() ? "&" : ""}transaction=${refundOriginal.id}`}>{refundOriginal.description} · {refundOriginal.posted_on}</Link></p>}
        {inboundRefunds?.length ? <div className="text-sm"><p className="text-muted-foreground">Refunds of this transaction:</p><ul className="mt-1 space-y-1">{inboundRefunds.map(item => <li key={item.id}><Link className="underline" href={`/money/transactions?${current.toString()}${current.toString() ? "&" : ""}transaction=${item.id}`}>{item.description} · {item.posted_on}</Link></li>)}</ul></div> : null}
        {inboundTransfer?.filter(item => item.id !== counterpart?.id).map(item => <p key={item.id} className="text-sm text-muted-foreground">Also linked here as transfer: {item.description} · {item.posted_on}</p>)}
        {splitSet.data ? <p className="text-sm text-muted-foreground">Undo splits before linking this transaction as a transfer or refund.</p> : selected.status !== "posted" ? <p className="text-sm text-muted-foreground">Only posted transactions can be marked as transfers or refunds.</p> : <>
          {!receipt.data && <form method="get" className="flex flex-wrap items-end gap-2"><input type="hidden" name="transaction" value={selected.id}/><label className="text-sm">Find other source by description<input name="linkSearch" defaultValue={linkSearch} maxLength={200} className="mt-1 block rounded border p-2"/></label><button className="rounded border px-3 py-2 text-sm">Find link source</button></form>}
          {receipt.data ? <div className="space-y-3 rounded border p-3"><p className="text-sm">Verified {receipt.data.operation}; canonical source amounts retained.</p><pre className="whitespace-pre-wrap text-xs">{JSON.stringify({ fx:receipt.data.fx_evidence, originalEquivalentMinor:receipt.data.original_equivalent_minor, fees:fees.data },null,2)}</pre><form action={undoVerifiedLink}><input type="hidden" name="id" value={selected.id}/><input type="hidden" name="linkId" value={receipt.data.id}/><input type="hidden" name="query" value={current.toString()}/><input type="hidden" name="rows" value={JSON.stringify([{id:selected.id,version:selected.version},...(counterpart?[{id:counterpart.id,version:counterpart.version}]:[])])}/><button className="text-sm underline">Undo verified link</button></form></div> : <>
            {selected.kind==="ordinary" && <VerifiedLinkEditor locale={workspace.locale} operation="transfer" primary={selected} candidates={transferCandidates} rates={rates.data??[]} categories={categories??[]} query={current.toString()}/>}
            {["ordinary","refund"].includes(selected.kind) && !selected.refund_of_id && selectedAmount!==null && selectedAmount>0n && <><VerifiedLinkEditor locale={workspace.locale} operation="refund" primary={selected} candidates={refundCandidates} rates={rates.data??[]} categories={categories??[]} query={current.toString()}/><form action={markRefund}><input type="hidden" name="id" value={selected.id}/><input type="hidden" name="version" value={selected.version}/><input type="hidden" name="query" value={current.toString()}/><button className="text-sm underline">Mark standalone refund without an original</button></form></>}
          </>}
          {!receipt.data && (selected.kind !== "ordinary" || selected.transfer_id || selected.refund_of_id) && <form action={clearLink} className="border-t pt-4"><input type="hidden" name="id" value={selected.id} /><input type="hidden" name="version" value={selected.version} /><input type="hidden" name="query" value={current.toString()} /><button className="text-sm underline">Clear to ordinary</button></form>}
        </>}
      </section>
      <form action={correctTransaction} className="mt-6 space-y-3 border-t pt-5">
        <input type="hidden" name="id" value={selected.id} /><input type="hidden" name="version" value={selected.version} /><input type="hidden" name="query" value={current.toString()} />
        <label className="block text-sm">Category<input name="category" defaultValue={category?.name ?? ""} readOnly={!!splitSet.data} maxLength={100} className="mt-1 block w-full rounded border p-2" /></label>
        <label className="block text-sm">Note<textarea name="note" defaultValue={selected.note ?? ""} maxLength={2000} className="mt-1 block w-full rounded border p-2" /></label>
        <button className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground">Save correction</button>
      </form>
      <h3 className="mt-8 font-medium">Original source</h3><pre aria-label="Original source evidence" className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{JSON.stringify(manualSource ? { type: "manual", ...manualSource } : sources ?? [], null, 2)}</pre>
      <h3 className="mt-8 font-medium">Correction history</h3>
      {history?.length ? <ul className="mt-2 space-y-2 text-sm">{history.map((event, index) => <li key={event.id} className="rounded border p-3">
        <p>{new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })} {event.undone ? "· undone" : ""}</p>
        <pre className="mt-2 whitespace-pre-wrap text-xs">{JSON.stringify({ before: event.before, after: event.after }, null, 2)}</pre>
        {index === history.findIndex(item => !item.undone) && <form action={undoCorrection} className="mt-3"><input type="hidden" name="rows" value={JSON.stringify([{ id:selected.id,version:selected.version },...(counterpart?[{id:counterpart.id,version:counterpart.version}]:[])])} /><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="transactionId" value={selected.id} /><input type="hidden" name="version" value={selected.version} /><input type="hidden" name="query" value={current.toString()} /><button className="underline">Undo correction</button></form>}
      </li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">No corrections yet.</p>}
    </aside>}
  </main>;
}
