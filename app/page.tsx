import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { hasSupabase } from "@/lib/env";
import { createAccount, setManualBalance } from "./actions";

function money(minor: string, currency: string) {
  const value = BigInt(minor);
  const sign = value < 0n ? "−" : "";
  const abs = value < 0n ? -value : value;
  return `${sign}${currency} ${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
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
    .eq("workspace_id", workspace.id).order("as_of", { ascending: false }).order("created_at", { ascending: false });
  const latest = new Map<string, NonNullable<typeof snapshots>[number]>();
  for (const snapshot of snapshots ?? []) if (!latest.has(snapshot.account_id)) latest.set(snapshot.account_id, snapshot);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div><p className="text-sm uppercase tracking-widest text-muted-foreground">Moneo</p><h1 className="text-3xl font-semibold">Home</h1></div>
        <nav aria-label="Main" className="flex flex-wrap gap-4 text-sm">
          <Link href="/import">Import</Link><Link href="/money/transactions">Transactions</Link><Link href="/plan">Plan</Link><Link href="/ai">AI</Link>
        </nav>
      </header>
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
    </main>
  );
}
