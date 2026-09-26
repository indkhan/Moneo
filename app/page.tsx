import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { hasSupabase } from "@/lib/env";

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
    supabase.from("accounts").select("id, name, currency_code").eq("workspace_id", workspace.id).order("name"),
    supabase.from("transactions").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id),
  ]);
  const { data: snapshots } = await supabase.from("balance_snapshots")
    .select("account_id, amount_minor, currency_code, as_of, provenance")
    .eq("workspace_id", workspace.id).order("as_of", { ascending: false });
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
            </article>;
          })}
        </div>
      </section>
      <section className="mt-10 rounded-lg border p-5">
        <h2 className="font-semibold">Transactions</h2>
        <p className="mt-2 text-muted-foreground">{transactionCount ?? 0} accepted transactions</p>
        <Link href="/money/transactions" className="mt-3 inline-block underline">Browse transactions</Link>
      </section>
    </main>
  );
}
