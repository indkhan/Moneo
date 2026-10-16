import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireWorkspace } from "@/lib/auth";
import { calendarDate } from "@/lib/finance/calendar";
import { debtPayments, loadWealthItems, type WealthItem } from "@/lib/finance/wealth";
import { formatMoney as formatCurrency } from "@/lib/finance/format";
import { SourceCoverageDetails } from "@/app/source-coverage";
import { Sparkline } from "@/app/money/accounts/sparkline";
import { WealthForm } from "./form";
import { removeWealthItem, undoWealthEvent } from "./actions";
import { monthEnds, netWorth, netWorthSeries } from "./net-worth";

const MONTHS = 12;
const sections = [["holding", "Investments"], ["asset", "Assets"], ["debt", "Debts"]] as const;
type WealthEvent = { id: string; item_id: string; before: WealthItem | null; after: WealthItem; created_at: string; undone_at: string | null };

async function all<T>(query: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await query(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data ?? []) as T[]);
    if (!data || data.length < 1000) return rows;
  }
}

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
  const [items, accounts, assumptions, pending, events, snapshots] = await Promise.all([
    loadWealthItems(supabase, workspace.id, true),
    supabase.from("accounts").select("id, name, type, currency_code, archived_at").eq("workspace_id", workspace.id).order("name"),
    supabase.from("financial_assumptions").select("id, name, amount_minor::text, currency_code, starts_on").eq("workspace_id", workspace.id).eq("confirmed", true).eq("enabled", true).eq("cadence", "monthly").is("removed_at", null).order("name"),
    supabase.from("transactions").select("id, description, amount_minor::text, currency_code, posted_on").eq("workspace_id", workspace.id).eq("status", "pending").order("posted_on", { ascending: false }).limit(100),
    all<WealthEvent>((from, to) => db.from("wealth_events").select("id, item_id, before, after, created_at, undone_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).order("id").range(from, to)),
    all<{ account_id: string; amount_minor: string; currency_code: string; as_of: string; undone_at: string | null }>((from, to) => db.from("balance_snapshots").select("account_id, amount_minor::text, currency_code, as_of, undone_at").eq("workspace_id", workspace.id).order("id").range(from, to)),
  ]);
  for (const result of [accounts, assumptions, pending]) if (result.error) throw result.error;
  const active = items.filter(item => !item.removed_at);
  const choices = { accounts: accounts.data ?? [], assumptions: (assumptions.data ?? []).map(item => ({ id: item.id, label: `${item.name} · ${formatMoney(item.amount_minor, item.currency_code)} · ${item.starts_on}` })),
    pending: (pending.data ?? []).map(item => ({ id: item.id, label: `${item.description} · ${formatMoney(item.amount_minor, item.currency_code)} · ${item.posted_on}` })), today, currency: workspace.display_currency };
  const itemById = new Map(items.map(item => [item.id, item]));

  // Valuation history = every non-undone saved version of each item, plus the current row.
  const valuations = [...events.filter(event => !event.undone_at && !event.after.removed_at).map(event => ({ ...event.after, item_id: event.item_id, created_at: event.created_at, amount_minor: String(event.after.amount_minor) })),
    ...items.map(item => ({ ...item, item_id: item.id, created_at: "9999-12-31" }))];
  const series = netWorthSeries({ dates: monthEnds(today, MONTHS), timeZone: workspace.timezone,
    accountIds: new Set((accounts.data ?? []).filter(account => !account.archived_at).map(account => account.id)), snapshots, valuations,
    removedOn: new Map(items.filter(item => item.removed_at).map(item => [item.id, calendarDate(item.removed_at!, workspace.timezone)])) });
  const now = series.at(-1)!;
  const totals = netWorth(now);
  const currencies = [...totals.keys()].sort((a, b) => Number(b === workspace.display_currency) - Number(a === workspace.display_currency) || a.localeCompare(b));
  const dated = active.filter(item => !item.linked_account_id && item.as_of !== today).length;

  return <main className="mx-auto w-full max-w-6xl space-y-8 px-4 py-8 sm:px-8 lg:py-10">
    <header className="space-y-4">
      <nav aria-label="Money sections" className="flex gap-4 text-sm text-muted-foreground"><Link className="hover:text-foreground" href="/money/transactions">Transactions</Link><Link className="hover:text-foreground" href="/money/accounts">Accounts</Link><Link className="hover:text-foreground" href="/money/recurring">Recurring</Link></nav>
      <div><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Investments, assets and debts</h1>
        <p className="mt-1 text-sm text-muted-foreground">What you own and owe, and your recorded net worth over time. Values already inside an account balance aren’t counted twice.</p></div>
    </header>

    <section aria-label="Net worth" className="grid gap-4 lg:grid-cols-2">
      {currencies.length ? currencies.map(currency => <div key={currency} className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-medium text-muted-foreground">Net worth ({currency})</h2>
          <p className="font-mono text-2xl font-semibold tabular-nums">{formatMoney(totals.get(currency) ?? 0n, currency)}</p></div>
        <div className="mt-3"><Sparkline width={480} height={72} className="w-full text-brand" label={`Recorded net worth in ${currency} at each month end`}
          points={series.map(point => ({ date: point.date, value: netWorth(point).get(currency) ?? 0n }))} /></div>
        <p className="mt-1 flex justify-between text-xs text-muted-foreground"><span>{series[0].date}</span><span>{today}</span></p>
        <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
          {([["Accounts", now.accounts], ["Investments & assets", now.assets], ["Debts", now.debts]] as const).map(([label, map]) => <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-mono tabular-nums">{formatMoney(map.get(currency) ?? 0n, currency)}</dd></div>)}
        </dl>
      </div>) : <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">No recorded balances or valuations yet.</p>}
      <p className="text-xs text-muted-foreground lg:col-span-2">Latest recorded account balance and valuation on each date, carried forward until updated. Per currency, without exchange rates; gaps between records are unknown.{dated > 0 ? ` ${dated} valuation${dated === 1 ? " is" : "s are"} dated before today and ${dated === 1 ? "is" : "are"} left out of the current forecast; update ${dated === 1 ? "it" : "them"} below.` : ""}</p>
    </section>

    <section aria-label="Add wealth" className="grid gap-3 sm:grid-cols-3">{sections.map(([kind, title]) => <details key={kind} className="rounded-xl border border-border bg-card p-4 open:sm:col-span-3"><summary className="cursor-pointer text-sm font-semibold">Add {kind === "holding" ? "investment" : kind}<span className="sr-only"> ({title})</span></summary><WealthForm kind={kind} {...choices} /></details>)}</section>

    {sections.map(([kind, title]) => {
      const rows = active.filter(item => item.kind === kind);
      if (!rows.length) return null;
      return <section key={kind} aria-label={title} className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-base font-semibold">{title} <span className="text-muted-foreground">({rows.length})</span></h2>
          <p className="font-mono text-sm tabular-nums">{[...sum(rows)].map(([currency, amount]) => formatMoney(amount, currency)).join(" · ")}</p></div>
        {rows.map(item => {
          const payments = (() => { try { return item.kind === "debt" && item.next_payment_on && BigInt(item.monthly_payment_minor ?? "0") > 0n ? debtPayments({ principalMinor: BigInt(item.amount_minor), annualRate: item.annual_rate_text!, monthlyPaymentMinor: BigInt(item.monthly_payment_minor!), nextPaymentOn: item.next_payment_on }, today, 365) : []; } catch { return null; } })();
          return <article key={item.id} className="space-y-1 rounded-xl border border-border bg-card px-5 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-base font-semibold">{item.name}</h3>
              <p className="font-mono text-base font-semibold tabular-nums">{formatMoney(item.amount_minor, item.currency_code)}</p></div>
            <p className="text-sm text-muted-foreground"><span className="capitalize">{item.kind}</span> · as of {item.as_of} · {item.linked_account_id ? "Already included in linked account balance; excluded from additional net worth." : item.as_of === today ? "Standalone current manual valuation." : "Historical manual valuation; current net worth excludes it."}</p>
            {item.sourceCoverage && <SourceCoverageDetails coverage={item.sourceCoverage} />}
            {item.kind === "holding" && <p className="text-sm">{item.quantity_text} units at {item.currency_code} {item.unit_price_text} each.</p>}
            {item.cost_basis_minor !== null && <p className="text-sm">Cost basis {formatMoney(item.cost_basis_minor, item.currency_code)}; valuation gain/loss {formatMoney(BigInt(item.amount_minor) - BigInt(item.cost_basis_minor), item.currency_code)}. This is unrealized value change, without guessed cash dividends or trading history.</p>}
            {item.kind === "debt" && <><p className="text-sm">Outstanding principal {formatMoney(item.amount_minor, item.currency_code)}; nominal annual rate {item.annual_rate_text}%; monthly repayment {formatMoney(item.monthly_payment_minor ?? "0", item.currency_code)}.</p>{payments === null ? <p className="text-sm text-amber-700 dark:text-amber-300">Update the next repayment date and outstanding principal before projecting payments.</p> : <ul className="space-y-0.5 text-sm text-muted-foreground">{payments.slice(0, 3).map(payment => <li key={payment.date}>{payment.date}: {formatMoney(payment.paymentMinor, item.currency_code)} payment, {formatMoney(payment.interestMinor, item.currency_code)} assumed interest, {formatMoney(payment.remainingMinor, item.currency_code)} remaining principal</li>)}</ul>}</>}
            <div className="flex flex-wrap items-start gap-4 pt-1">
              <details className="min-w-0 flex-1"><summary className="cursor-pointer text-sm underline">Edit valuation and details</summary><WealthForm kind={item.kind} item={item} {...choices} /></details>
              <form action={removeWealthItem}><input type="hidden" name="id" value={item.id} /><input type="hidden" name="version" value={item.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><button className="text-sm text-muted-foreground underline hover:text-foreground">Remove wealth record (keep history)</button></form>
            </div>
          </article>;
        })}
      </section>;
    })}
    {!active.length && <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Nothing added yet. Add an investment, asset or debt above.</p>}

    <details className="rounded-xl border border-border bg-card p-5"><summary className="cursor-pointer text-base font-semibold">Wealth source history and undo</summary><ul className="mt-4 divide-y divide-border">{events.slice(0, 50).map(event => {
      const { after, before } = event; const current = itemById.get(event.item_id);
      return <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"><span><span className="font-medium">{after.name}</span> · {before ? formatMoney(before.amount_minor, before.currency_code) : "New manual source"} → {formatMoney(after.amount_minor, after.currency_code)} · valued {after.as_of}{after.removed_at ? " · Removed" : ""}<span className="text-muted-foreground"> · {new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}{event.undone_at ? " · Undone" : ""}</span></span>
        {!event.undone_at && current && <form action={undoWealthEvent}><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={current.version} /><button className="underline">Undo wealth change</button></form>}</li>;
    })}</ul>{!events.length && <p className="mt-2 text-sm text-muted-foreground">Every add, edit and removal appears here with undo.</p>}</details>
  </main>;
}
