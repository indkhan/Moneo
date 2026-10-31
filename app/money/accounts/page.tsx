import Link from "next/link";
import { randomUUID } from "node:crypto";
import { requireWorkspace } from "@/lib/auth";
import { balanceReviewRows, loadBalanceEvidence, resolveBalances, type BalanceSnapshot } from "@/lib/finance/balances";
import { calendarDate } from "@/lib/finance/calendar";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";
import { addAccount, undoBalance, undoMoneyMetadata } from "./actions";
import { AccountForm, BalanceForm, RenameSuggestion } from "./account-form";
import { accountTypes, suggestAccountName } from "./naming";
import { balanceTrend, shownBalance } from "./history";
import { Sparkline } from "./sparkline";
import { OwnAccounts } from "./own-accounts";

const field = "min-h-9 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm";
const TREND_DAYS = 90;
type Resolved = ReturnType<typeof resolveBalances>[number];
type MetaEvent = { id: string; entity_type: string; entity_id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; created_at: string; undone_at: string | null; undo_of: string | null };

function describeEvent(event: MetaEvent) {
  const before = event.before ?? {}, after = event.after ?? {};
  const changes = [
    before.name !== after.name && before.name && after.name ? `renamed “${before.name}” → “${after.name}”` : null,
    before.type !== after.type && before.type && after.type ? `type ${before.type} → ${after.type}` : null,
    Boolean(before.archived_at) !== Boolean(after.archived_at) ? (after.archived_at ? "archived" : "restored") : null,
    Boolean(before.removed_at) !== Boolean(after.removed_at) ? (after.removed_at ? "removed" : "restored") : null,
  ].filter(Boolean);
  return `${event.entity_type === "account" ? "Account" : "Saved view"} ${String(after.name ?? before.name ?? "")}${changes.length ? `: ${changes.join(", ")}` : ""}`;
}

export default async function AccountsPage({ searchParams }: { searchParams?: Promise<{ transfers?: string }> } = {}) {
  const { transfers } = (await searchParams) ?? {};
  const { supabase, workspace } = await requireWorkspace();
  const [evidence, { data: history, error: historyError }, { data: views, error: viewsError }, { data: bankAccounts, error: bankError }, { data: identifiers, error: identifierError }] = await Promise.all([
    loadBalanceEvidence(supabase, workspace.id),
    supabase.from("money_metadata_events").select("id,entity_type,entity_id,before,after,created_at,undone_at,undo_of").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(30),
    supabase.from("transaction_views").select("id,version").eq("workspace_id", workspace.id),
    supabase.from("bank_connection_accounts").select("account_name,currency_code,iban").eq("workspace_id", workspace.id),
    supabase.from("own_account_identifiers").select("id,account_id,iban,label").eq("workspace_id", workspace.id).order("created_at"),
  ]);
  if (historyError || viewsError || bankError || identifierError) throw new Error("Could not load account and saved view history");
  // A bank sync imports into the account with the bank's name and currency, so those accounts take their balance from the sync.
  const synced = new Set((bankAccounts ?? []).map(connected => JSON.stringify([connected.account_name, connected.currency_code])));
  const { timezone: timeZone, locale } = workspace;
  const today = calendarDate(evidence.asOf, timeZone);
  const trendFrom = calendarDate(new Date(Date.parse(evidence.asOf) - TREND_DAYS * 86400000), timeZone);
  // Same balance basis as Overview and Wealth, so the totals match across screens.
  const accounts = resolveBalances(evidence.accounts, evidence.snapshots, evidence.ledger, evidence.asOf, timeZone, undefined, { preferLatestRecorded: true })
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  const active = accounts.filter(account => !account.archived_at), archived = accounts.filter(account => account.archived_at);
  const descriptions = new Map(evidence.ledger.map(row => [row.id, row.description]));
  const snapshotsByAccount = new Map<string, BalanceSnapshot[]>();
  for (const snapshot of evidence.snapshots) snapshotsByAccount.set(snapshot.account_id, [...(snapshotsByAccount.get(snapshot.account_id) ?? []), snapshot]);

  const totals = new Map<string, bigint>();
  let partial = false;
  for (const account of active) {
    const { amount } = shownBalance(account.balance);
    if (amount === null || account.balance.status === "ambiguous") { partial = true; continue; }
    totals.set(account.currency_code, (totals.get(account.currency_code) ?? 0n) + BigInt(amount));
  }

  const versions = new Map<string, number>([...accounts.map(account => [account.id, account.version ?? 1] as const), ...(views ?? []).map(view => [view.id, view.version] as const)]);
  const events = (history ?? []) as MetaEvent[];
  const latestVersion = new Map<string, number>();
  for (const event of events) if (!event.undone_at && !event.undo_of)
    latestVersion.set(event.entity_id, Math.max(latestVersion.get(event.entity_id) ?? 0, Number(event.after?.version ?? 0)));
  const canUndo = (event: MetaEvent) => !event.undone_at && !event.undo_of && versions.has(event.entity_id) && Number(event.after?.version ?? 0) >= (latestVersion.get(event.entity_id) ?? 0);
  const when = new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium", timeStyle: "short" });

  const row = (account: Resolved) => {
    const { amount, label } = shownBalance(account.balance);
    const snapshots = snapshotsByAccount.get(account.id) ?? [];
    const trend = balanceTrend(snapshots, account.id, account.currency_code, timeZone, trendFrom, amount !== null && account.balance.status !== "ambiguous" ? { date: today, value: BigInt(amount) } : undefined);
    const ordered = [...snapshots].sort((a, b) => Date.parse(b.created_at ?? b.as_of) - Date.parse(a.created_at ?? a.as_of) || (b.id ?? "").localeCompare(a.id ?? ""));
    const latest = ordered[0];
    const newestActive = ordered.find(snapshot => !snapshot.undone_at);
    const manual = ordered.filter((snapshot): snapshot is BalanceSnapshot & { id: string } => Boolean(snapshot.actor_id && snapshot.id)).slice(0, 5);
    const suggestion = suggestAccountName(account.name);
    const asOf = account.balance.as_of ? calendarDate(account.balance.as_of, timeZone) : null;
    return <article key={account.id} className="px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 basis-80">
          <AccountForm key={`${account.id}:${account.version}`} account={{ id: account.id, name: account.name, type: account.type ?? "checking", version: account.version ?? 1, archived_at: account.archived_at ?? null }} requestId={randomUUID()} />
          <p className="mt-1 flex flex-wrap items-center gap-x-3 px-2 text-xs text-muted-foreground">
            <span>{account.currency_code}</span>
            {account.archived_at ? <span>Archived</span> : null}
            <Link className="hover:text-foreground hover:underline" href={`/money/transactions?account=${account.id}`}>Transactions</Link>
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Sparkline points={trend} label={`${account.name} recorded balance, last ${TREND_DAYS} days`} />
          <div className="min-w-36 text-right">
            <p className="font-mono text-base font-semibold tabular-nums">{amount === null ? "—" : formatMoney(amount, account.currency_code, locale)}</p>
            <p className={`text-xs ${account.balance.status === "missing" || account.balance.status === "ambiguous" ? "text-warning" : "text-muted-foreground"}`}>
              {account.balance.status === "ambiguous" ? `${label} · not in total` : `${label}${asOf ? ` · as of ${asOf}` : ""}`}</p>
          </div>
        </div>
      </div>
      {account.balance.status === "stale" ? <p className="mt-2 px-2 text-xs text-muted-foreground">Last recorded balance plus later activity; update it to confirm.</p> : null}
      {account.balance.unconfirmed_rows ? <p className="mt-2 px-2 text-xs text-warning">{account.balance.warnings.at(-1)}.</p> : null}
      {suggestion ? <div className="mt-2 px-2"><RenameSuggestion account={{ id: account.id, name: account.name, type: account.type ?? "checking", version: account.version ?? 1, archived_at: account.archived_at ?? null }} suggestion={suggestion} requestId={randomUUID()} /></div> : null}
      {!account.archived_at && !synced.has(JSON.stringify([account.name, account.currency_code])) ? <details className="mt-2 px-2 text-sm" open={account.balance.status === "missing" && active.length === 1}>
        <summary className="cursor-pointer text-xs font-medium text-brand">Update balance</summary>
        <div className="mt-3 space-y-3">
          <BalanceForm accountId={account.id} name={account.name} currency={account.currency_code} today={today} requestId={randomUUID()}
            expectedSnapshotId={latest?.id ?? ""} expectedVersion={latest?.version ?? 0}
            placeholder={amount !== null ? formatInputAmount(amount, account.currency_code) : "0.00"}
            review={balanceReviewRows(evidence.ledger, account.id, evidence.asOf, timeZone).map(covered => ({ id: covered.id, covered,
              label: `${descriptions.get(covered.id) ?? "Recorded posting"} · ${formatMoney(covered.amount_minor, covered.currency_code, locale)}` }))} />
          <p className="text-xs text-muted-foreground">The booked balance your bank shows. Earlier balances stay in history.</p>
          {manual.length ? <ul className="divide-y divide-border text-xs">{manual.map(snapshot => <li key={snapshot.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className={snapshot.undone_at ? "text-muted-foreground line-through" : ""}>{formatMoney(snapshot.amount_minor, snapshot.currency_code, locale)} · as of {calendarDate(snapshot.as_of, timeZone)}{snapshot.boundary_kind === "reviewed_activity" ? " · activity reviewed" : ""}</span>
            {snapshot.undone_at ? <span className="text-muted-foreground">Undone</span> : snapshot.id === newestActive?.id && latest ? <form action={undoBalance}>
              <input type="hidden" name="snapshotId" value={snapshot.id} /><input type="hidden" name="expectedVersion" value={snapshot.version ?? 1} />
              <input type="hidden" name="expectedLatestId" value={latest.id} /><input type="hidden" name="expectedLatestVersion" value={latest.version ?? 1} />
              <button className="underline">Undo balance</button></form> : null}
          </li>)}</ul> : null}
        </div>
      </details> : null}
    </article>;
  };

  return <main className="mx-auto w-full max-w-[1400px] space-y-8 px-4 py-6 sm:px-8 lg:py-8">
    <header className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1"><p className="eyebrow">Money · balances and sources</p><h1 className="page-title">Accounts</h1></div>
        <details className="group relative">
          <summary className="inline-flex h-11 cursor-pointer list-none items-center rounded-xl bg-primary px-4 text-[13px] font-medium text-primary-foreground hover:opacity-90">Add account</summary>
          <form action={addAccount} className="absolute right-0 z-10 mt-2 grid w-72 gap-3 rounded-xl border border-border bg-card p-4 shadow-lg">
            <label className="grid gap-1 text-sm">Name<input name="name" className={field} maxLength={120} required /></label>
            <div className="flex gap-3">
              <label className="grid flex-1 gap-1 text-sm">Type<select name="type" className={field}>{accountTypes.map(type => <option key={type} value={type}>{type[0].toUpperCase() + type.slice(1)}</option>)}</select></label>
              <label className="grid gap-1 text-sm">Currency<input name="currency" className={`${field} w-20 uppercase`} defaultValue={workspace.display_currency} pattern="[A-Za-z]{3}" maxLength={3} required /></label>
            </div>
            <p className="text-xs text-muted-foreground">Currency can’t be changed later.</p>
            <button className="min-h-9 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">Add account</button>
          </form>
        </details>
      </div>
      {totals.size ? <dl className="rounded-xl border border-border bg-card px-5 py-4"><dt className="text-xs text-muted-foreground">Total across {active.length} active {active.length === 1 ? "account" : "accounts"}{partial ? " (partial)" : ""}</dt>
        {[...totals].map(([currency, amount]) => <dd key={currency} className="mt-1 font-mono text-2xl font-semibold tabular-nums">{formatMoney(amount, currency, locale)}</dd>)}</dl> : null}
    </header>

    {active.length ? <section className="divide-y divide-border rounded-xl border border-border bg-card" aria-label="Your accounts">{active.map(row)}</section>
      : <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">No accounts yet. Use Add account or <Link className="underline" href="/import">import a statement</Link>.</p>}

    <OwnAccounts identifiers={identifiers ?? []} accounts={active.map(account => ({ id: account.id, name: account.name }))} transfers={transfers}
      banked={(bankAccounts ?? []).flatMap(item => item.iban ? [{ iban: item.iban, name: item.account_name }] : [])} />

    {archived.length ? <section className="space-y-2 opacity-80" aria-label="Archived accounts"><h2 className="text-sm font-medium text-muted-foreground">Archived accounts ({archived.length})</h2><div className="divide-y divide-border rounded-xl border border-border bg-card">{archived.map(row)}</div></section> : null}

    {events.length ? <section><h2 className="text-sm font-medium text-muted-foreground">Account and saved view history</h2>
      <ul className="mt-2 divide-y divide-border text-sm">{events.map(event => <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
        <span>{describeEvent(event)} <span className="text-muted-foreground">· {when.format(new Date(event.created_at))}{event.undone_at ? " · Undone" : event.undo_of ? " · Restored by undo" : ""}</span></span>
        {canUndo(event) ? <form action={undoMoneyMetadata}><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={versions.get(event.entity_id)} /><input type="hidden" name="requestId" value={randomUUID()} /><button className={field}>Undo</button></form> : null}
      </li>)}</ul>
    </section> : null}
  </main>;
}
