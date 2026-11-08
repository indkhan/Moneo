import { CoverageNote } from "@/components/coverage-note";
import { ScalableInvestments } from "@/components/scalable-investments";
import type { ScalablePortfolio } from "@/lib/scalable/portfolio";
import { SafeForm } from "@/components/safe-form";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireWorkspace } from "@/lib/auth";
import { calendarDate } from "@/lib/finance/calendar";
import { currentOn, debtPayments, loadWealthItems, wealthEvidence, type WealthItem } from "@/lib/finance/wealth";
import { loadBalanceEvidence, resolveBalances } from "@/lib/finance/balances";
import { describeOutdated, formatMoney as formatCurrency } from "@/lib/finance/format";
import { NetWorthChart } from "@/app/net-worth-chart";
import { WealthForm } from "./form";
import { removeWealthItemSafely, undoWealthEventSafely } from "./actions";
import { currentNetWorth, dayRange, loadWealthEvents, monthEnds, netWorth, netWorthSeries, removedOn, valuationHistory } from "./net-worth";

export const metadata = { title: "Wealth" };

const MONTHS = 12;
const HISTORY = 50;
const sections = [["holding", "Investments"], ["asset", "Assets"], ["debt", "Debts"]] as const;

function sum(items: WealthItem[]) {
  const totals = new Map<string, bigint>();
  for (const item of items) if (!item.linked_account_id) totals.set(item.currency_code, (totals.get(item.currency_code) ?? 0n) + BigInt(item.amount_minor));
  return totals;
}

export default async function WealthPage({ searchParams }: { searchParams?: Promise<{ removed?: string; history?: string }> } = {}) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/setup"); }
  const { supabase, workspace } = context;
  const params = (await searchParams) ?? {};
  const db = supabase as SupabaseClient;
  const formatMoney = (amount: Parameters<typeof formatCurrency>[0], currency: string) => formatCurrency(amount, currency, workspace.locale);
  const today = calendarDate(new Date(), workspace.timezone);
  const [items, accounts, assumptions, pending, events, evidence, scalable] = await Promise.all([
    loadWealthItems(supabase, workspace.id, true),
    supabase.from("accounts").select("id, name, type, currency_code, archived_at").eq("workspace_id", workspace.id).order("name"),
    supabase.from("financial_assumptions").select("id, name, amount_minor::text, currency_code, starts_on").eq("workspace_id", workspace.id).eq("confirmed", true).eq("enabled", true).eq("cadence", "monthly").is("removed_at", null).order("name"),
    supabase.from("transactions").select("id, description, amount_minor::text, currency_code, posted_on").eq("workspace_id", workspace.id).eq("status", "pending").order("posted_on", { ascending: false }).limit(100),
    loadWealthEvents(db, workspace.id),
    loadBalanceEvidence(db, workspace.id),
    supabase.from("scalable_connections").select("status, last_synced_at, portfolio").eq("workspace_id", workspace.id).in("status", ["active", "expired", "error"])
      .not("portfolio", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  for (const result of [accounts, assumptions, pending]) if (result.error) throw result.error;
  const active = items.filter(item => !item.removed_at);
  const choices = { accounts: accounts.data ?? [], assumptions: (assumptions.data ?? []).map(item => ({ id: item.id, currency_code: item.currency_code, label: `${item.name} · ${formatMoney(item.amount_minor, item.currency_code)} · ${item.starts_on}` })),
    pending: (pending.data ?? []).map(item => ({ id: item.id, currency_code: item.currency_code, label: `${item.description} · ${formatMoney(item.amount_minor, item.currency_code)} · ${item.posted_on}` })), today, currency: workspace.display_currency, locale: workspace.locale };
  const itemById = new Map(items.map(item => [item.id, item]));

  const series = netWorthSeries({ dates: monthEnds(today, MONTHS), timeZone: workspace.timezone,
    accountIds: new Set((accounts.data ?? []).filter(account => !account.archived_at).map(account => account.id)), snapshots: evidence.snapshots, ledger: evidence.ledger,
    valuations: valuationHistory(events, items), removedOn: removedOn(items, workspace.timezone) });
  // Today uses the balances Accounts and Overview show and the same valuations, so the totals match theirs.
  const resolved = resolveBalances(evidence.accounts, evidence.snapshots, evidence.ledger, evidence.asOf, workspace.timezone, undefined, { preferLatestRecorded: true }).filter(account => !account.archived_at);
  const valuations = wealthEvidence(active, today);
  const now = currentNetWorth(today, resolved, valuations.included.map(valuation => ({ ...valuation, debt: itemById.get(valuation.id)?.kind === "debt" })));
  series[series.length - 1] = now;
  const unbalanced = resolved.filter(account => account.balance.amount_minor === null).length;
  const totals = netWorth(now);
  const currencies = [...totals.keys()].sort((a, b) => Number(b === workspace.display_currency) - Number(a === workspace.display_currency) || a.localeCompare(b));
  const chartPoints = (currency: string) => series.flatMap(point => { const value = netWorth(point).get(currency); return value === undefined ? [] : [{ date: point.date, value }]; });
  const history = params.history === "all" ? events : events.slice(0, HISTORY);
  // Scalable's synced positions, cash and crypto get their own panel; they still count in net worth like any valuation.
  const portfolio = (scalable.data?.portfolio ?? null) as ScalablePortfolio | null;
  const scalableIds = new Set(portfolio?.itemIds ?? []), knownIds = new Set([...(portfolio?.knownItemIds ?? []), ...scalableIds]);
  const scalableHistory = (() => {
    if (!portfolio) return [];
    const valuations = valuationHistory(events, items).filter(row => knownIds.has(row.item_id));
    // Daily from the first synced value, at most a year back.
    const yearAgo = new Date(Date.parse(today) - 365 * 86400000).toISOString().slice(0, 10);
    const from = valuations.reduce((min, row) => row.as_of < min ? row.as_of : min, today) < yearAgo ? yearAgo : valuations.reduce((min, row) => row.as_of < min ? row.as_of : min, today);
    return netWorthSeries({ dates: dayRange(from, today), timeZone: workspace.timezone, accountIds: new Set(), snapshots: [], valuations, removedOn: removedOn(items, workspace.timezone) })
      .flatMap(point => { const value = point.assets.get(portfolio.currency); return value === undefined ? [] : [{ date: point.date, value }]; });
  })();

  return <main className="mx-auto w-full max-w-[1400px] space-y-8 px-4 py-6 sm:px-8 lg:py-8">
    <header className="flex flex-col gap-1"><p className="eyebrow">Investments · assets · debts</p><h1 className="page-title">Wealth</h1></header>

    <section aria-label="Net worth" className="space-y-4">
      {currencies.map(currency => { const recorded = chartPoints(currency); const values = recorded.map(point => point.value); const low = values.reduce((a, b) => b < a ? b : a, values[0]), high = values.reduce((a, b) => b > a ? b : a, values[0]); return <div key={currency} className="rounded-xl border border-border bg-card p-6">
        <h2 className="text-sm text-muted-foreground">Net worth ({currency})</h2>
        <p className="mt-1 break-words font-mono text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">{formatMoney(totals.get(currency) ?? 0n, currency)}</p>
        <div className="mt-1"><CoverageNote counted={resolved.length - unbalanced} total={resolved.length} /></div>
        <dl className="mt-5 grid gap-4 sm:grid-cols-3 border-t border-border pt-4 text-sm">
          {([["Accounts", now.accounts], ["Investments & assets", now.assets], ["Debts", now.debts]] as const).map(([label, map]) => <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 break-words font-mono tabular-nums">{formatMoney(map.get(currency) ?? 0n, currency)}</dd></div>)}
        </dl>
        <div className="mt-5"><NetWorthChart label={`Recorded net worth in ${currency} at each month end`}
          points={recorded.map(point => ({ date: point.date, label: point.date === today ? "Today" : point.date, amount: formatMoney(point.value, currency), y: Number(point.value) }))} /></div>
        <p className="mt-1 flex justify-between text-xs text-muted-foreground"><span>{recorded[0].date}</span><span>Today</span></p>
        <p className="mt-1 text-xs text-muted-foreground">Lowest {formatMoney(low, currency)} · highest {formatMoney(high, currency)}</p>
        <details className="mt-2"><summary className="min-h-11 cursor-pointer content-center text-sm underline">Net worth by month</summary>
          <table className="mt-2 w-full text-sm"><caption className="sr-only">Recorded net worth in {currency} at each month end</caption><thead><tr className="border-b border-border text-left text-xs text-muted-foreground"><th scope="col" className="py-1.5 font-medium">Date</th><th scope="col" className="py-1.5 text-right font-medium">Net worth</th></tr></thead>
            <tbody>{series.map(point => { const value = netWorth(point).get(currency); return <tr key={point.date} className="border-b border-border last:border-0"><th scope="row" className="py-1.5 text-left font-normal">{point.date === today ? "Today" : point.date}</th><td className="py-1.5 text-right font-mono tabular-nums">{value === undefined ? "Nothing recorded" : formatMoney(value, currency)}</td></tr>; })}</tbody></table>
        </details>
      </div>; })}
      {valuations.outdated.length > 0 && <p className="text-xs text-muted-foreground">{describeOutdated(valuations.outdated)}</p>}
      {unbalanced > 0 && <p className="text-sm">{unbalanced} account{unbalanced === 1 ? " has" : "s have"} no usable balance and {unbalanced === 1 ? "is" : "are"} left out. <Link href="/money/accounts" className="font-medium text-brand underline">Review account balances</Link></p>}
      {!currencies.length && !active.length && <div className="rounded-xl border border-border bg-card p-6 text-sm"><p className="font-medium">Add your first item</p><p className="mt-1 text-muted-foreground">Net worth is your accounts plus investments and assets, minus debts. Start with one below.</p></div>}
      {!currencies.length && active.length > 0 && <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">No recorded balances or valuations count today yet.</p>}
    </section>

    {portfolio && <ScalableInvestments portfolio={portfolio} positions={active.filter(item => scalableIds.has(item.id) && item.kind === "holding").sort((a, b) => Number(BigInt(b.amount_minor) - BigInt(a.amount_minor)))}
      history={scalableHistory} syncedAt={scalable.data?.last_synced_at ?? null} active={scalable.data?.status === "active"} locale={workspace.locale} timeZone={workspace.timezone} />}

    <section aria-label="Add wealth" className="flex flex-wrap gap-2">{sections.map(([kind, title]) => <details key={kind} className="group rounded-lg border border-border bg-card open:basis-full open:p-5"><summary className="cursor-pointer px-3 py-1.5 text-sm font-medium group-open:p-0">Add {kind === "holding" ? "investment" : kind}<span className="sr-only"> ({title})</span></summary><WealthForm kind={kind} {...choices} /></details>)}</section>

    {sections.map(([kind, title]) => {
      const rows = active.filter(item => item.kind === kind && !scalableIds.has(item.id));
      if (!rows.length) return null;
      return <section key={kind} aria-label={title} className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-medium">{title} <span className="font-normal text-muted-foreground">{rows.length}</span></h2>
          <p className="font-mono text-sm text-muted-foreground tabular-nums">{[...sum(rows.filter(item => item.as_of <= today))].map(([currency, amount]) => formatMoney(amount, currency)).join(" · ")}</p></div>
        <div className="divide-y divide-border rounded-xl border border-border bg-card">{rows.map(item => {
          const payments = (() => { try { return item.kind === "debt" && item.next_payment_on && BigInt(item.monthly_payment_minor ?? "0") > 0n ? debtPayments({ principalMinor: BigInt(item.amount_minor), annualRate: item.annual_rate_text!, monthlyPaymentMinor: BigInt(item.monthly_payment_minor!), nextPaymentOn: item.next_payment_on }, today, 365) : []; } catch { return null; } })();
          return <article key={item.id} id={`item-${item.id}`} className="scroll-mt-24 space-y-2 px-5 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-medium">{item.name}</h3>
              <p className="font-mono font-semibold tabular-nums">{formatMoney(item.amount_minor, item.currency_code)}</p></div>
            <p className="text-xs text-muted-foreground">As of {item.as_of}{item.kind === "holding" ? ` · ${item.quantity_text} × ${item.currency_code} ${item.unit_price_text}` : ""}{item.kind === "debt" ? ` · ${item.annual_rate_text}% a year · ${formatMoney(item.monthly_payment_minor ?? "0", item.currency_code)}/month` : ""}{item.linked_account_id ? " · Inside an account balance" : item.as_of > today ? " · Dated in the future, not in net worth" : currentOn(item, today) ? "" : " · Not from today, last known value"}</p>
            {item.cost_basis_minor !== null && (() => { const gain = BigInt(item.amount_minor) - BigInt(item.cost_basis_minor); const cost = BigInt(item.cost_basis_minor);
              return <p className={`text-xs ${gain > 0n ? "text-success" : gain < 0n ? "text-danger" : "text-muted-foreground"}`}>{gain > 0n ? "+" : ""}{formatMoney(gain, item.currency_code)}{cost > 0n ? ` (${gain > 0n ? "+" : ""}${(Number(gain * 10000n / cost) / 100).toFixed(1)}%)` : ""} since bought for {formatMoney(cost, item.currency_code)}</p>; })()}
            {item.kind === "debt" && (payments === null ? <p className="text-xs text-warning">Update the next repayment date and principal to project payments.</p> : payments.length > 0 && <ul className="space-y-0.5 text-xs text-muted-foreground">{payments.slice(0, 3).map(payment => <li key={payment.date}>{payment.date}: {formatMoney(payment.paymentMinor, item.currency_code)} payment, {formatMoney(payment.interestMinor, item.currency_code)} assumed interest, {formatMoney(payment.remainingMinor, item.currency_code)} left</li>)}</ul>)}
            <div className="flex flex-wrap items-start gap-4">
              <details className="min-w-0 flex-1"><summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Edit valuation and details</summary><WealthForm kind={item.kind} item={item} {...choices} /></details>
              <SafeForm action={removeWealthItemSafely}><input type="hidden" name="id" value={item.id} /><input type="hidden" name="version" value={item.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><button aria-label={`Remove ${item.name} (keep history)`} className="min-h-11 text-sm text-muted-foreground hover:text-foreground">Remove</button></SafeForm>
            </div>
          </article>;
        })}</div>
      </section>;
    })}
    {params.removed === "1" && <p role="status" className="text-sm">Removed from your net worth. Its history is kept, and Undo below brings it back.</p>}
    <details id="wealth-history" open={params.removed === "1" || params.history === "all"} className="scroll-mt-24 rounded-xl border border-border bg-card px-5 py-4"><summary className="cursor-pointer text-sm font-medium">Wealth source history and undo</summary><ul className="mt-3 divide-y divide-border">{history.map(event => {
      const { after, before } = event; const current = itemById.get(event.item_id);
      return <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"><span><span className="font-medium">{after.name}</span> <span className="font-mono tabular-nums">{before ? formatMoney(before.amount_minor, before.currency_code) : "New"} → {formatMoney(after.amount_minor, after.currency_code)}</span>{after.removed_at ? " · Removed" : ""}
        <span className="block text-xs text-muted-foreground">Valued {after.as_of} · saved {new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}{event.undone_at ? " · Undone" : ""}</span></span>
        {!event.undone_at && current && <SafeForm action={undoWealthEventSafely}><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={current.version} /><button aria-label={`Undo ${after.name} change`} className="min-h-11 text-sm text-muted-foreground hover:text-foreground">Undo</button></SafeForm>}</li>;
    })}</ul>{history.length < events.length && <a href="/money/wealth?history=all#wealth-history" className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-brand underline">Show all {events.length} changes</a>}{!events.length && <p className="mt-2 text-sm text-muted-foreground">Every add, edit and removal appears here with undo.</p>}</details>
  </main>;
}
