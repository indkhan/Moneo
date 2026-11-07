import { calendarDate } from "@/lib/finance/calendar";
import { CurrencySelect } from "@/components/currency-select";
import { SafeForm } from "@/components/safe-form";
import { supportedCurrencies } from "@/lib/finance/fx";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { addFxRateSafely, setDisplayCurrencySafely } from "./actions";
import { RateFields } from "./rate-fields";

export const metadata = { title: "Currency" };

const RATE_LIMIT = 100, ALL_RATES_LIMIT = 1000;
const code = (value?: string) => /^[A-Z]{3}$/.test(value ?? "") && supportedCurrencies().includes(value!) ? value : undefined;
const card = "rounded-xl border border-border bg-card p-6";

type Params = { from?: string; to?: string; saved?: string; rates?: string };

export default async function CurrencyPage({ searchParams }: { searchParams?: Promise<Params> } = {}) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    redirect("/setup");
  }
  const { supabase, workspace } = context;
  const params = (await searchParams) ?? {};
  const limit = params.rates === "all" ? ALL_RATES_LIMIT : RATE_LIMIT;
  const [{ data: accounts, error: accountsError }, { data: rates, error: ratesError }] = await Promise.all([
    supabase.from("accounts").select("id, name, currency_code").eq("workspace_id", workspace.id).order("name"),
    supabase.from("fx_rates")
      .select("from_currency, to_currency, rate_text, rate_date, source")
      .eq("workspace_id", workspace.id)
      .order("rate_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);
  // A failed read must not claim there are no rates: the error page offers a retry instead.
  if (accountsError || ratesError) throw new Error("Currency data could not be loaded");
  const display = workspace.display_currency;
  const today = calendarDate(new Date(), workspace.timezone);
  const foreign = [...new Set((accounts ?? []).map(account => account.currency_code))].filter(currency => currency !== display).sort();
  const unlisted = foreign.filter(currency => !rates?.some(rate => (rate.from_currency === currency && rate.to_currency === display) || (rate.to_currency === currency && rate.from_currency === display)));
  // The list is capped, so a pair absent from a full list may still have an older rate.
  const older = rates?.length === limit ? await Promise.all(unlisted.map(currency => supabase.from("fx_rates").select("rate_date").eq("workspace_id", workspace.id)
    .or(`and(from_currency.eq.${currency},to_currency.eq.${display}),and(from_currency.eq.${display},to_currency.eq.${currency})`).limit(1))) : [];
  if (older.some(check => check.error)) throw new Error("Currency data could not be loaded");
  const missing = unlisted.filter((_, index) => !older[index]?.data?.length);
  const to = code(params.to) ?? display;
  const from = code(params.from) ?? foreign[0] ?? (to === "USD" ? "EUR" : "USD");
  const pairs = new Map<string, NonNullable<typeof rates>>();
  for (const rate of rates ?? []) { const pair = `${rate.from_currency} to ${rate.to_currency}`; pairs.set(pair, [...(pairs.get(pair) ?? []), rate]); }

  return (
    <main className="mx-auto w-full max-w-[1400px] space-y-8 px-4 py-6 text-foreground sm:px-8 lg:py-8">
      <header>
        <p className="eyebrow"><Link href="/plan" className="hover:text-foreground">Plan</Link> · display and exchange rates</p>
        <h1 className="mt-1 page-title">Currency</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose how amounts are shown. Your original transactions and balances are never changed.
        </p>
      </header>
      {params.saved === "rate" && <p role="status" className="text-sm font-medium">Rate saved.</p>}
      {params.saved === "display" && <p role="status" className="text-sm font-medium">Display currency is {display}.</p>}

      <section className={card}>
        <h2 className="text-sm font-medium">Display currency</h2>
        <p className="mt-1 text-sm text-muted-foreground">Currently {display}. Search by name or code.</p>
        <SafeForm action={setDisplayCurrencySafely} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm font-medium">Currency
            <CurrencySelect name="currency" label="Display currency" defaultValue={display} locale={workspace.locale} />
          </label>
          <button className="min-h-11 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">Save display currency</button>
        </SafeForm>
      </section>

      <section id="add-rate" className={`${card} scroll-mt-24`}>
        <h2 className="text-sm font-medium">Manual FX rate</h2>
        <p className="mt-1 text-sm text-muted-foreground">How many units of the second currency you get for 1 unit of the first. Balances use the latest rate on or before their date. Spending reports need a rate for the exact day. Missing rates stay unavailable, never zero.</p>
        <p className="mt-1 text-sm text-muted-foreground">Results round to the second currency&apos;s smallest unit. Bank fees and spreads are only included if the rate you enter includes them.</p>
        {foreign.length === 0 && <p className="mt-3 text-sm">All your accounts use {display}, so you do not need a rate.</p>}
        {missing.length > 0 && <ul className="mt-3 space-y-1 text-sm">{missing.map(currency => <li key={currency}>No {currency} to {display} rate saved yet. <Link href={`/plan/currency?from=${currency}&to=${display}#add-rate`} className="font-medium text-brand underline">Add this rate</Link></li>)}</ul>}
        <SafeForm action={addFxRateSafely} className="mt-4">
          <RateFields key={`${from}:${to}`} from={from} to={to} today={today} locale={workspace.locale} />
        </SafeForm>
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium">Saved rates</h2>
        {!rates?.length && <p className="mt-3 text-muted-foreground">No FX rates yet. Add one above to enable conversion.</p>}
        <div className="mt-4 space-y-5">{[...pairs].map(([pair, rows]) => <div key={pair}>
          <h3 className="text-sm font-medium">{pair}</h3>
          <ul className="mt-2 grid gap-3 sm:grid-cols-2">
            {rows.map((rate, index) => (
              <li key={`${rate.rate_date}-${index}`} className="rounded-lg border border-border bg-muted/35 p-3 text-sm">
                1 {rate.from_currency} = {rate.rate_text} {rate.to_currency} · {String(rate.rate_date).slice(0, 10)} · {rate.source}{index === 0 ? " · latest" : ""}
              </li>
            ))}
          </ul>
        </div>)}</div>
        {rates?.length === RATE_LIMIT && <p className="mt-3 text-sm text-muted-foreground">Showing the latest {RATE_LIMIT} rates. <Link href="/plan/currency?rates=all" className="text-brand underline">Show older rates</Link></p>}
        {rates?.length === ALL_RATES_LIMIT && <p className="mt-3 text-sm text-muted-foreground">Showing the latest {ALL_RATES_LIMIT} rates.</p>}
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium">Accounts</h2>
        <p className="mt-1 text-sm text-muted-foreground">An account keeps the currency it was opened in. The display currency only changes how totals are shown.</p>
        {!accounts?.length && <p className="mt-3 text-sm text-muted-foreground"><Link href="/money/accounts" className="text-brand underline">Add an account</Link> to start.</p>}
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {accounts?.map((account) => (
            <li key={account.id} className="rounded-lg border border-border bg-muted/35 p-3 text-sm"><Link href="/money/accounts" className="underline-offset-2 hover:underline">{account.name}</Link>: {account.currency_code}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
