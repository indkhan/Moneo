import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { hasSupabase } from "@/lib/env";
import { convertFx, minorDigits } from "@/lib/finance/fx";
import { createAccount, setManualBalance } from "./actions";
import { ArrowRight, Landmark, Plus, Wallet } from "lucide-react";

function money(minor: string | bigint, currency: string) {
  const value = BigInt(minor);
  const digits = minorDigits(currency);
  const base = 10n ** BigInt(digits);
  const sign = value < 0n ? "−" : "";
  const abs = value < 0n ? -value : value;
  const whole = (abs / base).toString();
  const frac = digits > 0 ? `.${(abs % base).toString().padStart(digits, "0")}` : "";
  return `${sign}${currency} ${whole}${frac}`;
}

export default async function Home() {
  if (!hasSupabase()) return <main className="mx-auto max-w-3xl p-8">Configure Supabase in .env to start Moneo.</main>;
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    redirect("/login");
  }
  const { supabase, workspace } = context;
  const [{ data: accounts }, { count: transactionCount }] = await Promise.all([
    supabase.from("accounts").select("id, name, type, currency_code").eq("workspace_id", workspace.id).order("name"),
    supabase.from("transactions").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id),
  ]);
  const { data: snapshots } = await supabase.from("balance_snapshots")
    .select("account_id, amount_minor, currency_code, as_of, provenance")
    .eq("workspace_id", workspace.id).lte("as_of", new Date().toISOString())
    .order("as_of", { ascending: false }).order("created_at", { ascending: false });
  const latest = new Map<string, NonNullable<typeof snapshots>[number]>();
  for (const snapshot of snapshots ?? []) if (!latest.has(snapshot.account_id)) latest.set(snapshot.account_id, snapshot);
  const { data: fxRates } = await supabase.from("fx_rates")
    .select("from_currency, to_currency, rate_text, rate_date, source")
    .eq("workspace_id", workspace.id)
    .order("rate_date", { ascending: false }).order("created_at", { ascending: false });
  const displayCurrency: string = workspace.display_currency;
  const missingInputs: string[] = [];
  let netWorthMinor = 0n;
  let convertedCount = 0;
  for (const account of accounts ?? []) {
    const balance = latest.get(account.id);
    if (!balance) {
      missingInputs.push(`balance:${account.name}`);
      continue;
    }
    const balanceDate = String(balance.as_of).slice(0, 10);
    const rate = balance.currency_code === displayCurrency ? undefined
      : (fxRates ?? []).find((row) =>
        row.from_currency === balance.currency_code &&
        row.to_currency === displayCurrency &&
        String(row.rate_date).slice(0, 10) <= balanceDate);
    try {
      const result = convertFx({
        amountMinor: BigInt(balance.amount_minor),
        from: balance.currency_code,
        to: displayCurrency,
        rate: balance.currency_code === displayCurrency ? undefined : rate?.rate_text,
        source: rate?.source ?? (balance.provenance || "balance"),
        date: rate ? String(rate.rate_date).slice(0, 10) : balanceDate,
      });
      if (result.status === "available") {
        netWorthMinor += result.converted.amountMinor;
        convertedCount += 1;
      } else {
        for (const missing of result.missingInputs) missingInputs.push(`${missing} for ${account.name}`);
      }
    } catch {
      missingInputs.push(`rate:${balance.currency_code}->${displayCurrency} for ${account.name}`);
    }
  }
  const { data: pins } = await supabase.from("dashboard_items")
    .select("artifact_id, position").eq("workspace_id", workspace.id).order("position");
  const { data: pinnedArtifacts } = pins?.length ? await supabase.from("artifacts")
    .select("id, name, kind").eq("workspace_id", workspace.id).in("id", pins.map(pin => pin.artifact_id))
    : { data: [] as { id: string; name: string; kind: string }[] };
  const pinnedById = new Map(pinnedArtifacts?.map(artifact => [artifact.id, artifact]));

  return (
    <main className="mx-auto max-w-[1600px] space-y-6 px-4 py-6 text-slate-900 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-700">Workspace overview</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">Home</h1><p className="mt-1 text-sm text-slate-500">Your accounts, ledger, and saved tools in one place.</p></div>
        <Link href="/import" className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800"><Plus size={15} /> Import statement</Link>
      </header>
      <section aria-label="Overview" className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(250px,1fr)]">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-[11px] font-medium uppercase tracking-wider text-slate-500">Net worth</p><p className="mt-1 text-xs text-slate-500">Latest dated balances in {displayCurrency}</p></div><Link href="/plan/currency" className="text-xs font-medium text-blue-700 hover:underline">Manage currency</Link></div>
          {!accounts?.length ? <p className="mt-7 text-sm text-slate-500">Add an account to see your net worth.</p> : convertedCount > 0 ? <><p className="mt-5 font-mono text-4xl font-semibold tracking-tight">{money(netWorthMinor, displayCurrency)}{missingInputs.length > 0 && <span className="ml-2 align-middle text-xs font-normal text-amber-700">Partial</span>}</p><p className="mt-2 text-xs text-slate-500">{missingInputs.length > 0 ? "Excludes accounts without a usable balance or exchange rate." : "Debts entered as negative balances are included."}</p>{missingInputs.length > 0 && <details className="mt-4 text-xs text-slate-600"><summary className="cursor-pointer text-blue-700">See missing inputs</summary><p className="mt-2">{missingInputs.join(", ")}</p></details>}</> : <><p className="mt-6 text-sm text-slate-500">Net worth unavailable in {displayCurrency}.</p><p className="mt-2 text-xs text-slate-500">{missingInputs.join(", ")}</p></>}
        </div>
        <Link href="/money/transactions" className="group flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6 shadow-sm hover:border-blue-300"><div className="flex items-center justify-between"><span className="font-mono text-[11px] font-medium uppercase tracking-wider text-slate-500">Transactions</span><ArrowRight size={16} className="text-blue-700 transition-transform group-hover:translate-x-1" /></div><div><p className="font-mono text-4xl font-semibold">{transactionCount ?? 0}</p><p className="mt-2 text-xs text-slate-500">Accepted ledger entries</p></div></Link>
      </section>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
        <section className="space-y-4"><div className="flex items-center justify-between"><div className="flex items-center gap-3"><span className="rounded-lg bg-blue-50 p-2 text-blue-700"><Landmark size={18} /></span><div><h2 className="text-base font-semibold">Accounts</h2><p className="text-xs text-slate-500">Balances you can verify and update</p></div></div><span className="font-mono text-xs text-slate-500">{accounts?.length ?? 0} total</span></div>
          {!accounts?.length && <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">No accounts yet. <Link className="text-blue-700 underline" href="/import">Import a statement</Link> or add one below.</div>}
          <div className="grid gap-3 md:grid-cols-2">{accounts?.map((account) => { const balance = latest.get(account.id); return <article key={account.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start gap-3"><span className="rounded-lg bg-slate-100 p-2 text-slate-600"><Wallet size={17} /></span><div className="min-w-0"><h3 className="truncate text-sm font-semibold">{account.name}</h3><p className="text-[11px] capitalize text-slate-500">{account.type}</p></div></div><p className="mt-5 font-mono text-xl font-semibold">{balance ? money(balance.amount_minor, balance.currency_code) : "Balance unknown"}</p><p className="mt-1 text-[11px] text-slate-500">{balance ? `${balance.provenance} · as of ${new Date(balance.as_of).toLocaleDateString()}` : "Add a dated balance"}</p><form action={setManualBalance} className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 text-xs"><input type="hidden" name="accountId" value={account.id} /><input name="amount" required placeholder="Balance" aria-label={`${account.name} balance`} className="w-24 rounded-md border border-slate-200 bg-white p-2" /><input name="asOf" required type="date" defaultValue={new Date().toISOString().slice(0, 10)} aria-label="Balance as of" className="min-w-0 rounded-md border border-slate-200 bg-white p-2" /><button className="font-medium text-blue-700 hover:underline">Save</button></form></article>; })}</div>
          <form action={createAccount} className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-4"><input name="name" required maxLength={120} placeholder="Account name" aria-label="Account name" className="min-w-36 flex-1 rounded-md border border-slate-200 p-2 text-xs" /><select name="type" aria-label="Account type" className="rounded-md border border-slate-200 p-2 text-xs"><option value="checking">Checking</option><option value="savings">Savings</option><option value="cash">Cash</option><option value="credit">Credit</option><option value="investment">Investment</option><option value="wallet">Wallet</option><option value="other">Other</option></select><input name="currency" defaultValue={workspace.display_currency} maxLength={3} aria-label="Currency code" className="w-16 rounded-md border border-slate-200 p-2 text-xs" /><button className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white"><Plus size={14} /> Add account</button></form>
        </section>
        <section className="space-y-4"><div className="flex items-center justify-between"><div><h2 className="text-base font-semibold">Pinned tools</h2><p className="text-xs text-slate-500">Saved from your AI Library</p></div><Link href="/ai/library" className="text-xs font-medium text-blue-700 hover:underline">Library <ArrowRight size={13} className="inline" /></Link></div><div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">{!pins?.length && <p className="text-sm text-slate-500">Pin a saved tool from your AI Library to open it here.</p>}<div className="divide-y divide-slate-100">{pins?.map(pin => { const artifact = pinnedById.get(pin.artifact_id); return artifact && <Link key={pin.artifact_id} href={`/ai/library/${artifact.id}`} className="group flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"><div><h3 className="text-sm font-medium">{artifact.name}</h3><p className="mt-1 text-[11px] capitalize text-slate-500">{artifact.kind.replaceAll("_", " ")}</p></div><ArrowRight size={15} className="text-slate-400 group-hover:text-blue-700" /></Link>; })}</div></div></section>
      </div>
    </main>
  );
}
