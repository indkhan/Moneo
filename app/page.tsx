import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { hasSupabase } from "@/lib/env";
import { convertFx, MINOR_DIGITS } from "@/lib/finance/fx";
import { createAccount, setManualBalance } from "./actions";

function money(minor: string | bigint, currency: string) {
  const value = BigInt(minor);
  const digits = MINOR_DIGITS[currency] ?? 2;
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
  const convertedLines: { name: string; text: string }[] = [];
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
        convertedLines.push({ name: account.name, text: money(result.converted.amountMinor, displayCurrency) });
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
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div><p className="text-sm uppercase tracking-widest text-muted-foreground">Moneo</p><h1 className="text-3xl font-semibold">Home</h1></div>
        <nav aria-label="Main" className="flex flex-wrap gap-4 text-sm">
          <Link href="/import">Import</Link><Link href="/money/transactions">Transactions</Link><Link href="/plan">Plan</Link><Link href="/ai">AI</Link>
        </nav>
      </header>
      <section aria-label="Net worth" className="mt-10 rounded-lg border p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-xl font-semibold">Net worth</h2>
          <Link href="/plan/currency" className="text-sm underline">Manage currency</Link>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Enter debts as negative balances for this signed total.</p>
        {!accounts?.length ? (
          <p className="mt-3 text-muted-foreground">Net worth unavailable: no accounts yet.</p>
        ) : missingInputs.length === 0 ? (
          <>
            <p className="mt-3 text-3xl font-semibold">{money(netWorthMinor, displayCurrency)}</p>
            <p className="mt-1 text-xs text-muted-foreground">In {displayCurrency} · from latest dated balances · originals unchanged</p>
          </>
        ) : convertedCount > 0 ? (
          <>
            <p className="mt-3 text-3xl font-semibold">{money(netWorthMinor, displayCurrency)} <span className="text-base font-normal text-muted-foreground">partial</span></p>
            <p className="mt-1 text-xs text-muted-foreground">Partial total in {displayCurrency}; excludes accounts below. Never zero-filled.</p>
            <ul className="mt-3 space-y-1 text-sm">
              {convertedLines.map((line) => <li key={line.name}>{line.name}: {line.text}</li>)}
            </ul>
            <p className="mt-3 text-sm text-muted-foreground">Missing inputs: {missingInputs.join(", ")}</p>
          </>
        ) : (
          <>
            <p className="mt-3 text-muted-foreground">Net worth unavailable in {displayCurrency}.</p>
            <p className="mt-1 text-sm text-muted-foreground">Missing inputs: {missingInputs.join(", ")}</p>
          </>
        )}
      </section>
      <section className="mt-10">
        <h2 className="text-xl font-semibold">Accounts</h2>
        {!accounts?.length && <p className="mt-3 text-muted-foreground">No accounts yet. <Link className="underline" href="/import">Import a statement</Link> to begin.</p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {accounts?.map((account) => {
            const balance = latest.get(account.id);
            return <article key={account.id} className="rounded-lg border p-5">
              <h3 className="font-medium">{account.name}</h3>
              <p className="mt-2 text-2xl font-semibold">{balance ? money(balance.amount_minor, balance.currency_code) : "Balance unknown"}</p>
              <p className="mt-1 text-xs text-muted-foreground">{balance ? `${balance.provenance} · as of ${new Date(balance.as_of).toLocaleDateString()}` : "Add a dated balance to show available cash"}</p>
              <form action={setManualBalance} className="mt-4 flex flex-wrap gap-2 text-sm"><input type="hidden" name="accountId" value={account.id} /><input name="amount" required placeholder="Balance" aria-label={`${account.name} balance`} className="w-28 rounded border p-2" /><input name="asOf" required type="date" defaultValue={new Date().toISOString().slice(0, 10)} aria-label="Balance as of" className="rounded border p-2" /><button className="underline">Save balance</button></form>
            </article>;
          })}
        </div>
        <form action={createAccount} className="mt-5 flex flex-wrap gap-2"><input name="name" required maxLength={120} placeholder="Account name" className="rounded border p-2" /><select name="type" aria-label="Account type" className="rounded border p-2"><option value="checking">Checking</option><option value="savings">Savings</option><option value="cash">Cash</option><option value="credit">Credit</option><option value="investment">Investment</option><option value="wallet">Wallet</option><option value="other">Other</option></select><input name="currency" defaultValue={workspace.display_currency} maxLength={3} aria-label="Currency code" className="w-20 rounded border p-2" /><button className="rounded bg-primary px-4 text-primary-foreground">Add account</button></form>
      </section>
      <section className="mt-10 rounded-lg border p-5">
        <h2 className="font-semibold">Transactions</h2>
        <p className="mt-2 text-muted-foreground">{transactionCount ?? 0} accepted transactions</p>
        <Link href="/money/transactions" className="mt-3 inline-block underline">Browse transactions</Link>
      </section>
      <section className="mt-10">
        <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-semibold">Pinned tools</h2><Link href="/ai/library" className="text-sm underline">Library</Link></div>
        {!pins?.length && <p className="mt-3 text-muted-foreground">Pin a saved tool from your AI Library.</p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">{pins?.map(pin => {
          const artifact = pinnedById.get(pin.artifact_id);
          return artifact && <Link key={pin.artifact_id} href={`/ai/library/${artifact.id}`} className="rounded-lg border p-5">
            <h3 className="font-medium">{artifact.name}</h3><p className="mt-2 text-sm text-muted-foreground">{artifact.kind.replaceAll("_", " ")} · opens with current data</p>
          </Link>;
        })}</div>
      </section>
    </main>
  );
}
