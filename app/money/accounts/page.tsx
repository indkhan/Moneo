import Link from "next/link";
import { SafeForm } from "@/components/safe-form";
import { CoverageNote } from "@/components/coverage-note";
import { randomUUID } from "node:crypto";
import { requireWorkspace } from "@/lib/auth";
import { balanceReviewRows, loadBalanceEvidence, resolveBalances, type BalanceSnapshot } from "@/lib/finance/balances";
import { calendarDate } from "@/lib/finance/calendar";
import { closingTargets } from "@/lib/finance/account-closing";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";
import { addAccountSafely, undoBalanceSafely, undoMoneyMetadataSafely } from "./actions";
import { AddAccountPanel } from "./add-account-panel";
import { AccountForm, BalanceForm, RenameSuggestion } from "./account-form";
import { accountTypes, suggestAccountName } from "./naming";
import { balanceTrend, shownBalance, trendSummary } from "./history";
import { Sparkline } from "./sparkline";
import { OwnAccounts } from "./own-accounts";
import { ScalablePortfolioView } from "@/components/scalable-portfolio";
import type { ScalablePortfolio } from "@/lib/scalable/portfolio";

export const metadata = { title: "Accounts" };

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

export default async function AccountsPage({ searchParams }: { searchParams?: Promise<{ transfers?: string; saved?: string }> } = {}) {
  const { transfers, saved } = (await searchParams) ?? {};
  const { supabase, workspace } = await requireWorkspace();
  const [evidence, { data: history, error: historyError }, { data: views, error: viewsError }, { data: bankAccounts, error: bankError }, { data: identifiers, error: identifierError }, { data: scalable }] = await Promise.all([
    loadBalanceEvidence(supabase, workspace.id),
    supabase.from("money_metadata_events").select("id,entity_type,entity_id,before,after,created_at,undone_at,undo_of").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(30),
    supabase.from("transaction_views").select("id,version").eq("workspace_id", workspace.id),
    supabase.from("bank_connection_accounts").select("account_name,currency_code,iban,bank_connections(status)").eq("workspace_id", workspace.id),
    supabase.from("own_account_identifiers").select("id,account_id,iban,label").eq("workspace_id", workspace.id).order("created_at"),
    // The broker shows here once connected; connecting lives on Import. A failed read only hides it.
    supabase.from("scalable_connections").select("status, last_synced_at, portfolio").eq("workspace_id", workspace.id).in("status", ["active", "expired", "error"])
      .not("portfolio", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (historyError || viewsError || bankError || identifierError) throw new Error("Could not load account and saved view history");
  // A bank sync imports into the account with the bank's name and currency, so those accounts take their balance from the sync.
  const synced = new Set((bankAccounts ?? []).map(connected => JSON.stringify([connected.account_name, connected.currency_code])));
  // A revoked connection sends nothing more, so money moved there needs both rows.
  const stillFed = new Set((bankAccounts ?? []).filter(connected => (connected.bank_connections as unknown as { status: string } | null)?.status !== "revoked").map(connected => JSON.stringify([connected.account_name, connected.currency_code])));
  const { timezone: timeZone, locale } = workspace;
  const today = calendarDate(evidence.asOf, timeZone);
  const trendFrom = calendarDate(new Date(Date.parse(evidence.asOf) - TREND_DAYS * 86400000), timeZone);
  // Same balance basis as Overview and Wealth, so the totals match across screens.
  const accounts = resolveBalances(evidence.accounts, evidence.snapshots, evidence.ledger, evidence.asOf, timeZone)
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  const active = accounts.filter(account => !account.archived_at), archived = accounts.filter(account => account.archived_at);
  const descriptions = new Map(evidence.ledger.map(row => [row.id, row.description]));
  const snapshotsByAccount = new Map<string, BalanceSnapshot[]>();
  for (const snapshot of evidence.snapshots) snapshotsByAccount.set(snapshot.account_id, [...(snapshotsByAccount.get(snapshot.account_id) ?? []), snapshot]);

  const totals = new Map<string, bigint>();
  let counted = 0;
  for (const account of active) {
    const { amount } = shownBalance(account.balance);
    if (amount === null || account.balance.status === "ambiguous") continue;
    counted += 1;
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
    return <article key={account.id} id={`account-${account.id}`} aria-label={account.name} className="scroll-mt-24 px-4 py-4 sm:px-5">
      {saved === `balance:${account.id}` || saved === `account:${account.id}` ? <p role="status" className="mb-2 px-2 text-sm text-success">{saved.startsWith("balance") ? `Balance saved for ${account.name}.` : `${account.name} saved.`}</p> : null}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 basis-80">
          <AccountForm key={`${account.id}:${account.version}`} moneyLeft={account.balance.amount_minor !== null && BigInt(account.balance.amount_minor) !== 0n ? formatMoney(account.balance.amount_minor, account.currency_code, locale) : null} targets={closingTargets(account, accounts).map(({ id, name, type, currency_code }) => ({ id, name, type, bankSynced: stillFed.has(JSON.stringify([name, currency_code])) }))} account={{ id: account.id, name: account.name, type: account.type ?? "checking", version: account.version ?? 1, archived_at: account.archived_at ?? null }} requestId={randomUUID()} />
          <p className="mt-1 flex flex-wrap items-center gap-x-3 px-2 text-xs text-muted-foreground">
            <span>{account.currency_code}</span>
            {account.archived_at ? <span>Archived</span> : null}
            <Link aria-label={`Transactions in ${account.name}`} className="hover:text-foreground hover:underline" href={`/money/transactions?account=${account.id}`}>Transactions</Link>
          </p>
        </div>
        <div className="flex items-center gap-4 max-sm:w-full max-sm:justify-between max-sm:px-2">
          <Sparkline points={trend} label={`${account.name} recorded balance, last ${TREND_DAYS} days`} />
          <div className="min-w-36 text-right">
            <p className="font-mono text-base font-semibold tabular-nums">{amount === null ? "—" : formatMoney(amount, account.currency_code, locale)}</p>
            <p className={`text-xs ${account.balance.status === "missing" || account.balance.status === "ambiguous" ? "text-warning" : "text-muted-foreground"}`}>
              {account.balance.status === "ambiguous" ? `${label} · not in total` : `${label}${asOf ? ` · as of ${asOf}` : ""}`}</p>
          </div>
        </div>
      </div>
      {trend.length > 1 ? <details className="mt-2 px-2 text-xs text-muted-foreground"><summary className="cursor-pointer hover:text-foreground">{trendSummary(trend, value => formatMoney(value, account.currency_code, locale))}</summary><ul className="mt-1 space-y-0.5">{trend.map(point => <li key={point.date} className="font-mono">{point.date} · {formatMoney(point.value, account.currency_code, locale)}</li>)}</ul><p className="mt-1">Only the balances recorded on these dates, not one for every day.</p></details> : null}
      {account.balance.status === "ambiguous" ? <div className="mt-2 px-2 text-xs"><p className="text-warning">Moneo can’t tell whether activity on that date came before or after this balance, so it’s left out of the total. Enter the balance your bank shows now to settle it.</p><details className="mt-1 text-muted-foreground"><summary className="cursor-pointer hover:text-foreground">Why</summary><p className="mt-1">{account.balance.warnings.join(" ")}</p></details></div> : null}
      {account.balance.status === "stale" ? <p className="mt-2 px-2 text-xs text-muted-foreground">Last recorded balance plus later activity; update it to confirm.</p> : null}
      {account.balance.conflicts.length > 0 && <div className="mt-2 px-2 text-xs text-warning"><p>Two balances disagree for this date. Moneo uses the most recently recorded one{account.balance.snapshot_amount_minor !== null ? `, ${formatMoney(account.balance.snapshot_amount_minor, account.balance.snapshot_currency_code ?? account.currency_code, locale)}` : ""}. The other said {account.balance.conflicts.map(other => formatMoney(other.amount_minor, other.currency_code, locale)).join(", ")}.</p></div>}
      {account.balance.unconfirmed_rows ? <p className="mt-2 px-2 text-xs text-warning">{account.balance.warnings.at(-1)}.</p> : null}
      {suggestion ? <div className="mt-2 px-2"><RenameSuggestion account={{ id: account.id, name: account.name, type: account.type ?? "checking", version: account.version ?? 1, archived_at: account.archived_at ?? null }} suggestion={suggestion} requestId={randomUUID()} /></div> : null}
      {!account.archived_at && !synced.has(JSON.stringify([account.name, account.currency_code])) ? <details className="mt-2 px-2 text-sm" open={(account.balance.status === "missing" && active.length === 1) || account.balance.status === "ambiguous"}>
        <summary className="cursor-pointer text-xs font-medium text-brand">{account.balance.status === "ambiguous" ? "Review balance" : "Update balance"}</summary>
        <div className="mt-3 space-y-3">
          <BalanceForm accountId={account.id} name={account.name} currency={account.currency_code} today={today} requestId={randomUUID()}
            expectedSnapshotId={latest?.id ?? ""} expectedVersion={latest?.version ?? 0}
            placeholder={amount !== null ? formatInputAmount(amount, account.currency_code) : "0.00"}
            review={balanceReviewRows(evidence.ledger, account.id, evidence.asOf, timeZone).map(covered => ({ id: covered.id, covered,
              label: `${descriptions.get(covered.id) ?? "Recorded posting"} · ${formatMoney(covered.amount_minor, covered.currency_code, locale)}` }))} />
          <p className="text-xs text-muted-foreground">Booked balance is what your bank shows as settled, without pending items or any overdraft limit. Earlier balances stay in history.</p>
          {manual.length ? <ul className="divide-y divide-border text-xs">{manual.map(snapshot => <li key={snapshot.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className={snapshot.undone_at ? "text-muted-foreground line-through" : ""}>{formatMoney(snapshot.amount_minor, snapshot.currency_code, locale)} · as of {calendarDate(snapshot.as_of, timeZone)}{snapshot.boundary_kind === "reviewed_activity" ? " · activity reviewed" : ""}</span>
            {snapshot.undone_at ? <span className="text-muted-foreground">Undone</span> : snapshot.id === newestActive?.id && latest ? <SafeForm action={undoBalanceSafely}>
              <input type="hidden" name="snapshotId" value={snapshot.id} /><input type="hidden" name="expectedVersion" value={snapshot.version ?? 1} />
              <input type="hidden" name="expectedLatestId" value={latest.id} /><input type="hidden" name="expectedLatestVersion" value={latest.version ?? 1} />
              <button aria-label={`Undo balance of ${formatMoney(snapshot.amount_minor, snapshot.currency_code, locale)} for ${account.name}`} className="underline">Undo balance</button></SafeForm> : null}
          </li>)}</ul> : null}
        </div>
      </details> : null}
    </article>;
  };

  return <main className="mx-auto w-full max-w-[1400px] space-y-8 px-4 py-6 sm:px-8 lg:py-8">
    <header className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1"><p className="eyebrow">Money · balances and sources</p><h1 className="page-title">Accounts</h1></div>
        <AddAccountPanel>
          <SafeForm action={addAccountSafely} className="absolute right-0 z-10 mt-2 grid w-72 max-w-[calc(100vw-2rem)] gap-3 rounded-xl border border-border bg-card p-4 shadow-lg">
            <label className="grid gap-1 text-sm">Name<input name="name" className={field} maxLength={120} required /></label>
            <div className="flex gap-3">
              <label className="grid flex-1 gap-1 text-sm">Type<select name="type" className={field}>{accountTypes.map(type => <option key={type} value={type}>{type[0].toUpperCase() + type.slice(1)}</option>)}</select></label>
              <label className="grid gap-1 text-sm">Currency<input name="currency" className={`${field} w-20 uppercase`} defaultValue={workspace.display_currency} pattern="[A-Za-z]{3}" maxLength={3} required /></label>
            </div>
            <p className="text-xs text-muted-foreground">Currency can’t be changed later.</p>
            <button className="min-h-9 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">Add account</button>
            <button type="button" data-close className="min-h-9 rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted">Cancel</button>
          </SafeForm>
        </AddAccountPanel>
      </div>
      {totals.size ? <dl className="rounded-xl border border-border bg-card px-5 py-4"><dt className="text-xs text-muted-foreground">Total{counted === active.length ? ` across ${active.length} active ${active.length === 1 ? "account" : "accounts"}` : ""}</dt>
        {[...totals].map(([currency, amount]) => <dd key={currency} className="mt-1 font-mono text-2xl font-semibold tabular-nums">{formatMoney(amount, currency, locale)}</dd>)}<dd className="mt-1"><CoverageNote counted={counted} total={active.length} /></dd></dl>
        : active.length ? <p className="rounded-xl border border-warning/40 bg-card px-5 py-4 text-sm text-warning">Total unavailable: {active.length} {active.length === 1 ? "account needs" : "accounts need"} a usable balance. <a className="underline" href="#needs-balance">Review {active.length === 1 ? "it" : "them"}</a>.</p> : null}
    </header>

    {active.length ? <section id="needs-balance" className="scroll-mt-20 divide-y divide-border rounded-xl border border-border bg-card" aria-label="Your accounts">{active.map(row)}</section>
      : <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">No accounts yet. Use Add account or <Link className="underline" href="/import">import a statement</Link>.</p>}

    {scalable?.portfolio && <section id="scalable" aria-labelledby="scalable-portfolio" className="scroll-mt-20 space-y-3 rounded-xl border border-border bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="scalable-portfolio" className="text-sm font-medium">Scalable Capital</h2>
        <p className="text-xs text-muted-foreground">{scalable.status === "active" ? "Synced" : "Login ended, showing the last sync"}{scalable.last_synced_at ? ` · ${new Date(scalable.last_synced_at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", timeZone })}` : ""} · <Link href="/import#scalable" className="text-brand hover:underline">Manage</Link></p></div>
      <ScalablePortfolioView portfolio={scalable.portfolio as ScalablePortfolio} locale={locale} />
    </section>}

    <OwnAccounts identifiers={identifiers ?? []} accounts={active.map(account => ({ id: account.id, name: account.name }))} transfers={transfers}
      banked={(bankAccounts ?? []).flatMap(item => item.iban ? [{ iban: item.iban, name: item.account_name }] : [])} />

    {archived.length ? <section className="space-y-2 opacity-80" aria-label="Archived accounts"><h2 className="text-sm font-medium text-muted-foreground">Archived accounts ({archived.length})</h2><div className="divide-y divide-border rounded-xl border border-border bg-card">{archived.map(row)}</div></section> : null}

    {events.length ? <section><h2 className="text-sm font-medium text-muted-foreground">Account and saved view history</h2>
      <ul className="mt-2 divide-y divide-border text-sm">{events.map(event => <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
        <span>{describeEvent(event)} <span className="text-muted-foreground">· {when.format(new Date(event.created_at))}{event.undone_at ? " · Undone" : event.undo_of ? " · Restored by undo" : ""}</span></span>
        {canUndo(event) ? <SafeForm action={undoMoneyMetadataSafely}><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={versions.get(event.entity_id)} /><input type="hidden" name="requestId" value={randomUUID()} /><button aria-label={`Undo: ${describeEvent(event)}`} className={field}>Undo</button></SafeForm> : null}
      </li>)}</ul>
    </section> : null}
  </main>;
}
