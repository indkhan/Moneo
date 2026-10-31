import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireWorkspace } from "@/lib/auth";
import { calendarDate } from "@/lib/finance/calendar";
import { currentOn, debtPayments, loadWealthItems, wealthEvidence, type WealthItem } from "@/lib/finance/wealth";
import { loadBalanceEvidence, resolveBalances } from "@/lib/finance/balances";
import { formatMoney as formatCurrency } from "@/lib/finance/format";
import { SourceCoverageDetails } from "@/app/source-coverage";
import { Sparkline } from "@/app/money/accounts/sparkline";
import { WealthForm } from "./form";
import { removeWealthItem, undoWealthEvent } from "./actions";
import { currentNetWorth, loadWealthEvents, monthEnds, netWorth, netWorthSeries, removedOn, valuationHistory } from "./net-worth";

const MONTHS = 12;
const sections = [["holding", "Investments"], ["asset", "Assets"], ["debt", "Debts"]] as const;

function sum(items: WealthItem[]) {
  const totals = new Map<string, bigint>();
  for (const item of items) if (!item.linked_account_id) totals.set(item.currency_code, (totals.get(item.currency_code) ?? 0n) + BigInt(item.amount_minor));
  return totals;
}

export default async function WealthPage() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const db = supabase as SupabaseClient;
  const formatMoney = (amount: Parameters<typeof formatCurrency>[0], currency: string) => formatCurrency(amount, currency, workspace.locale);
  const today = calendarDate(new Date(), workspace.timezone);
  const [items, accounts, assumptions, pending, events, evidence] = await Promise.all([
    loadWealthItems(supabase, workspace.id, true),
    supabase.from("accounts").select("id, name, type, currency_code, archived_at").eq("workspace_id", workspace.id).order("name"),
    supabase.from("financial_assumptions").select("id, name, amount_minor::text, currency_code, starts_on").eq("workspace_id", workspace.id).eq("confirmed", true).eq("enabled", true).eq("cadence", "monthly").is("removed_at", null).order("name"),
    supabase.from("transactions").select("id, description, amount_minor::text, currency_code, posted_on").eq("workspace_id", workspace.id).eq("status", "pending").order("posted_on", { ascending: false }).limit(100),
    loadWealthEvents(db, workspace.id),
    loadBalanceEvidence(db, workspace.id),
  ]);
  for (const result of [accounts, assumptions, pending]) if (result.error) throw result.error;
  const active = items.filter(item => !item.removed_at);
  const choices = { accounts: accounts.data ?? [], assumptions: (assumptions.data ?? []).map(item => ({ id: item.id, label: `${item.name} · ${formatMoney(item.amount_minor, item.currency_code)} · ${item.starts_on}` })),
    pending: (pending.data ?? []).map(item => ({ id: item.id, label: `${item.description} · ${formatMoney(item.amount_minor, item.currency_code)} · ${item.posted_on}` })), today, currency: workspace.display_currency };
  const itemById = new Map(items.map(item => [item.id, item]));

  const series = netWorthSeries({ dates: monthEnds(today, MONTHS), timeZone: workspace.timezone,
    accountIds: new Set((accounts.data ?? []).filter(account => !account.archived_at).map(account => account.id)), snapshots: evidence.snapshots, ledger: evidence.ledger,
    valuations: valuationHistory(events, items), removedOn: removedOn(items, workspace.timezone) });
  // Today uses the balances Accounts and Overview show and only valuations that count today, so the totals match theirs.
  const resolved = resolveBalances(evidence.accounts, evidence.snapshots, evidence.ledger, evidence.asOf, workspace.timezone, undefined, { preferLatestRecorded: true }).filter(account => !account.archived_at);
  const now = currentNetWorth(today, resolved, wealthEvidence(active, today).included.map(valuation => ({ ...valuation, debt: itemById.get(valuation.id)?.kind === "debt" })));
  series[series.length - 1] = now;
  const unbalanced = resolved.filter(account => account.balance.amount_minor === null).length;
  const totals = netWorth(now);
  const currencies = [...totals.keys()].sort((a, b) => Number(b === workspace.display_currency) - Number(a === workspace.display_currency) || a.localeCompare(b));
  const dated = active.filter(item => !item.linked_account_id && !currentOn(item, today)).length;

  return <main className="mx-auto w-full max-w-[1400px] space-y-8 px-4 py-6 sm:px-8 lg:py-8">
    <header className="flex flex-col gap-1"><p className="eyebrow">Investments · assets · debts</p><h1 className="page-title">Wealth</h1></header>

    <section aria-label="Net worth" className="space-y-4">
      {currencies.length ? currencies.map(currency => <div key={currency} className="rounded-xl border border-border bg-card p-6">
        <h2 className="text-sm text-muted-foreground">Net worth ({currency})</h2>
        <p className="mt-1 font-mono text-4xl font-semibold tracking-tight tabular-nums">{formatMoney(totals.get(currency) ?? 0n, currency)}</p>
        <dl className="mt-5 grid grid-cols-3 gap-4 border-t border-border pt-4 text-sm">
          {([["Accounts", now.accounts], ["Investments & assets", now.assets], ["Debts", now.debts]] as const).map(([label, map]) => <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 font-mono tabular-nums">{formatMoney(map.get(currency) ?? 0n, currency)}</dd></div>)}
        </dl>
        <Sparkline width={480} height={56} className="mt-5 w-full text-brand" label={`Recorded net worth in ${currency} at each month end`}
          points={series.map(point => ({ date: point.date, value: netWorth(point).get(currency) ?? 0n }))} />
        <p className="mt-1 flex justify-between text-xs text-muted-foreground"><span>{series[0].date}</span><span>{today}</span></p>
      </div>) : <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">No recorded balances or valuations yet.</p>}
      <p className="text-xs text-muted-foreground">Per currency, no exchange rates. Accounts are the balances shown on Accounts, including activity recorded since each balance was set; earlier months use the balances recorded then. Values inside an account balance aren’t counted twice.{unbalanced > 0 ? ` ${unbalanced} account${unbalanced === 1 ? " has" : "s have"} no usable balance and ${unbalanced === 1 ? "is" : "are"} left out.` : ""}{dated > 0 ? ` ${dated} valuation${dated === 1 ? " is" : "s are"} dated before today and left out of current net worth.` : ""}</p>
    </section>

    <section aria-label="Add wealth" className="flex flex-wrap gap-2">{sections.map(([kind, title]) => <details key={kind} className="group rounded-lg border border-border bg-card open:basis-full open:p-5"><summary className="cursor-pointer px-3 py-1.5 text-sm font-medium group-open:p-0">Add {kind === "holding" ? "investment" : kind}<span className="sr-only"> ({title})</span></summary><WealthForm kind={kind} {...choices} /></details>)}</section>

    {sections.map(([kind, title]) => {
      const rows = active.filter(item => item.kind === kind);
      if (!rows.length) return null;
      return <section key={kind} aria-label={title} className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-medium">{title} <span className="font-normal text-muted-foreground">{rows.length}</span></h2>
          <p className="font-mono text-sm text-muted-foreground tabular-nums">{[...sum(rows)].map(([currency, amount]) => formatMoney(amount, currency)).join(" · ")}</p></div>
        <div className="divide-y divide-border rounded-xl border border-border bg-card">{rows.map(item => {
          const payments = (() => { try { return item.kind === "debt" && item.next_payment_on && BigInt(item.monthly_payment_minor ?? "0") > 0n ? debtPayments({ principalMinor: BigInt(item.amount_minor), annualRate: item.annual_rate_text!, monthlyPaymentMinor: BigInt(item.monthly_payment_minor!), nextPaymentOn: item.next_payment_on }, today, 365) : []; } catch { return null; } })();
          return <article key={item.id} className="space-y-2 px-5 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-medium">{item.name}</h3>
              <p className="font-mono font-semibold tabular-nums">{formatMoney(item.amount_minor, item.currency_code)}</p></div>
            <p className="text-xs text-muted-foreground">As of {item.as_of}{item.kind === "holding" ? ` · ${item.quantity_text} × ${item.currency_code} ${item.unit_price_text}` : ""}{item.kind === "debt" ? ` · ${item.annual_rate_text}% a year · ${formatMoney(item.monthly_payment_minor ?? "0", item.currency_code)}/month` : ""}{item.linked_account_id ? " · Inside an account balance" : currentOn(item, today) ? "" : " · Outdated, not in current net worth"}</p>
            {item.cost_basis_minor !== null && <p className="text-xs text-muted-foreground">Cost basis {formatMoney(item.cost_basis_minor, item.currency_code)} · valuation gain/loss {formatMoney(BigInt(item.amount_minor) - BigInt(item.cost_basis_minor), item.currency_code)} (unrealized)</p>}
            {item.kind === "debt" && (payments === null ? <p className="text-xs text-warning">Update the next repayment date and principal to project payments.</p> : payments.length > 0 && <ul className="space-y-0.5 text-xs text-muted-foreground">{payments.slice(0, 3).map(payment => <li key={payment.date}>{payment.date}: {formatMoney(payment.paymentMinor, item.currency_code)} payment, {formatMoney(payment.interestMinor, item.currency_code)} assumed interest, {formatMoney(payment.remainingMinor, item.currency_code)} left</li>)}</ul>)}
            {item.sourceCoverage && <SourceCoverageDetails coverage={item.sourceCoverage} />}
            <div className="flex flex-wrap items-start gap-4">
              <details className="min-w-0 flex-1"><summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Edit valuation and details</summary><WealthForm kind={item.kind} item={item} {...choices} /></details>
              <form action={removeWealthItem}><input type="hidden" name="id" value={item.id} /><input type="hidden" name="version" value={item.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><button aria-label="Remove wealth record (keep history)" className="text-sm text-muted-foreground hover:text-foreground">Remove</button></form>
            </div>
          </article>;
        })}</div>
      </section>;
    })}
    {!active.length && <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Nothing added yet. Add an investment, asset or debt above.</p>}

    <details className="rounded-xl border border-border bg-card px-5 py-4"><summary className="cursor-pointer text-sm font-medium">Wealth source history and undo</summary><ul className="mt-3 divide-y divide-border">{events.slice(0, 50).map(event => {
      const { after, before } = event; const current = itemById.get(event.item_id);
      return <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"><span><span className="font-medium">{after.name}</span> <span className="font-mono tabular-nums">{before ? formatMoney(before.amount_minor, before.currency_code) : "New"} → {formatMoney(after.amount_minor, after.currency_code)}</span>{after.removed_at ? " · Removed" : ""}
        <span className="block text-xs text-muted-foreground">Valued {after.as_of} · saved {new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}{event.undone_at ? " · Undone" : ""}</span></span>
        {!event.undone_at && current && <form action={undoWealthEvent}><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={current.version} /><button className="text-sm text-muted-foreground hover:text-foreground">Undo wealth change</button></form>}</li>;
    })}</ul>{!events.length && <p className="mt-2 text-sm text-muted-foreground">Every add, edit and removal appears here with undo.</p>}</details>
  </main>;
}
