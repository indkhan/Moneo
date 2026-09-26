import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { MINOR_DIGITS } from "@/lib/finance/fx";
import { addFxRate, setDisplayCurrency } from "./actions";

export default async function CurrencyPage() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    redirect("/login");
  }
  const { supabase, workspace } = context;
  const supported = Object.keys(MINOR_DIGITS);
  const [{ data: accounts }, { data: rates }] = await Promise.all([
    supabase.from("accounts").select("id, name, currency_code").eq("workspace_id", workspace.id).order("name"),
    supabase.from("fx_rates")
      .select("from_currency, to_currency, rate_text, rate_date, source")
      .eq("workspace_id", workspace.id)
      .order("rate_date", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="mx-auto max-w-3xl space-y-10 px-6 py-10">
      <header>
        <Link href="/plan" className="text-sm text-muted-foreground">← Plan</Link>
        <h1 className="mt-2 text-3xl font-semibold">Currency</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Display currency is derived only. Original transactions, accounts and balances are never rewritten.
          Conversions use the most recent rate on or before each balance date; missing rates stay unavailable, never zero.
        </p>
      </header>

      <section className="rounded-lg border p-5">
        <h2 className="font-semibold">Display currency</h2>
        <p className="mt-1 text-sm text-muted-foreground">Currently {workspace.display_currency}. Supported: {supported.join(", ")}.</p>
        <form action={setDisplayCurrency} className="mt-4 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">Currency
            <select name="currency" defaultValue={workspace.display_currency} aria-label="Display currency" className="rounded border p-2">
              {supported.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <button className="rounded bg-primary px-4 py-2 text-primary-foreground">Save display currency</button>
        </form>
      </section>

      <section className="rounded-lg border p-5">
        <h2 className="font-semibold">Manual FX rate</h2>
        <p className="mt-1 text-sm text-muted-foreground">Directional exact decimal rate: 1 unit of From buys Rate units of To.</p>
        <form action={addFxRate} className="mt-4 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">From
            <select name="from" aria-label="From currency" className="rounded border p-2">
              {supported.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">To
            <select name="to" aria-label="To currency" className="rounded border p-2">
              {supported.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">Rate
            <input name="rate" required placeholder="1.08" inputMode="decimal" aria-label="Rate" className="w-32 rounded border p-2" />
          </label>
          <label className="grid gap-1 text-sm">Rate date
            <input name="rateDate" required type="date" defaultValue={today} max={today} aria-label="Rate date" className="rounded border p-2" />
          </label>
          <label className="grid gap-1 text-sm">Source
            <input name="source" defaultValue="manual" maxLength={120} aria-label="Rate source" className="w-32 rounded border p-2" />
          </label>
          <button className="rounded bg-primary px-4 py-2 text-primary-foreground">Add rate</button>
        </form>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Saved rates</h2>
        {!rates?.length && <p className="mt-3 text-muted-foreground">No FX rates yet. Add one above to enable conversion.</p>}
        <ul className="mt-4 space-y-2">
          {rates?.map((rate, index) => (
            <li key={`${rate.from_currency}-${rate.to_currency}-${rate.rate_date}-${index}`} className="rounded border p-3 text-sm">
              1 {rate.from_currency} = {rate.rate_text} {rate.to_currency} · {String(rate.rate_date).slice(0, 10)} · {rate.source}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Accounts</h2>
        <ul className="mt-4 space-y-2">
          {accounts?.map((account) => (
            <li key={account.id} className="rounded border p-3 text-sm">{account.name}: {account.currency_code}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
