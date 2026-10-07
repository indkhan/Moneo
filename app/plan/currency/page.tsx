import { calendarDate } from "@/lib/finance/calendar";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { addFxRate, setDisplayCurrency } from "./actions";

export default async function CurrencyPage() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    redirect("/login");
  }
  const { supabase, workspace } = context;
  const [{ data: accounts }, { data: rates }] = await Promise.all([
    supabase.from("accounts").select("id, name, currency_code").eq("workspace_id", workspace.id).order("name"),
    supabase.from("fx_rates")
      .select("from_currency, to_currency, rate_text, rate_date, source")
      .eq("workspace_id", workspace.id)
      .order("rate_date", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);
  const currencies = [...new Set([
    workspace.display_currency,
    ...(accounts ?? []).map((account) => account.currency_code),
    ...(rates ?? []).flatMap((rate) => [rate.from_currency, rate.to_currency]),
  ])].sort();
  const today = calendarDate(new Date(), workspace.timezone);

  return (
    <main className="mx-auto max-w-7xl space-y-7 px-4 py-8 text-foreground sm:px-6 lg:px-10">
      <header>
        <Link href="/plan" className="text-sm text-muted-foreground">← Plan</Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Currency</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Display currency is derived only. Original transactions, accounts and balances are never rewritten.
          Balance conversions use the most recent rate on or before each balance date. Expenditure base reports require a direct rate on the exact posting date and round each canonical posting half away from zero. Missing rates stay unavailable, never zero.
        </p>
      </header>

      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Display currency</h2>
        <p className="mt-1 text-sm text-muted-foreground">Currently {workspace.display_currency}. Enter any ISO 4217 currency code; conversions without a saved rate remain unavailable.</p>
        <form action={setDisplayCurrency} className="mt-4 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">Currency
            <input name="currency" list="currency-codes" defaultValue={workspace.display_currency} pattern="[A-Za-z]{3}" maxLength={3} required aria-label="Display currency" className="min-h-10 w-24 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
          </label>
          <button className="min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">Save display currency</button>
        </form>
      </section>

      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Manual FX rate</h2>
        <p className="mt-1 text-sm text-muted-foreground">Directional exact decimal rate: 1 unit of From buys Rate units of To.</p>
        <datalist id="currency-codes">{currencies.map((code) => <option key={code} value={code} />)}</datalist>
        <form action={addFxRate} className="mt-4 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">From
            <input name="from" list="currency-codes" defaultValue={currencies[0] ?? "EUR"} pattern="[A-Za-z]{3}" maxLength={3} required aria-label="From currency" className="min-h-10 w-24 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
          </label>
          <label className="grid gap-1 text-sm">To
            <input name="to" list="currency-codes" defaultValue={currencies[1] ?? "USD"} pattern="[A-Za-z]{3}" maxLength={3} required aria-label="To currency" className="min-h-10 w-24 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
          </label>
          <label className="grid gap-1 text-sm">Rate
            <input name="rate" required placeholder="1.08" inputMode="decimal" aria-label="Rate" className="min-h-10 w-32 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
          </label>
          <label className="grid gap-1 text-sm">Rate date
            <input name="rateDate" required type="date" defaultValue={today} max={today} aria-label="Rate date" className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
          </label>
          <label className="grid gap-1 text-sm">Source
            <input name="source" defaultValue="manual" maxLength={120} aria-label="Rate source" className="min-h-10 w-32 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
          </label>
          <button className="min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">Add rate</button>
        </form>
      </section>

      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Saved rates</h2>
        {!rates?.length && <p className="mt-3 text-muted-foreground">No FX rates yet. Add one above to enable conversion.</p>}
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {rates?.map((rate, index) => (
            <li key={`${rate.from_currency}-${rate.to_currency}-${rate.rate_date}-${index}`} className="rounded-lg border border-border bg-muted/35 p-3 text-sm">
              1 {rate.from_currency} = {rate.rate_text} {rate.to_currency} · {String(rate.rate_date).slice(0, 10)} · {rate.source}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Accounts</h2>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {accounts?.map((account) => (
            <li key={account.id} className="rounded-lg border border-border bg-muted/35 p-3 text-sm">{account.name}: {account.currency_code}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
