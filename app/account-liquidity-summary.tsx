import Link from "next/link";
import type { accountLiquidity } from "@/lib/finance/calculations";
import { formatMoney } from "@/lib/finance/format";

export function HomeLiquidity({ liquidity, accountId, names, locale }: {
  liquidity: ReturnType<typeof accountLiquidity>; accountId?: string; names: Map<string, string>; locale?: string;
}) {
  if (liquidity.status === "unavailable") return <div className="rounded-xl border border-border bg-card p-6 shadow-sm"><h2 className="text-base font-semibold">Aggregate headroom</h2><p className="mt-3 text-sm text-muted-foreground">Unavailable: {liquidity.missingInputs.join(", ")}</p><Link href="/plan" className="text-sm text-brand underline">Review forecast evidence</Link></div>;
  const selected = liquidity.accounts.find(account => account.accountId === accountId);
  const money = (amount: bigint) => formatMoney(amount, liquidity.currencyCode, locale);
  return <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
    <h2 className="text-base font-semibold">Aggregate headroom</h2>
    <p className="mt-3 font-mono text-2xl font-semibold">{money(liquidity.aggregate.amountMinor)}</p>
    <p className="mt-2 text-xs text-muted-foreground">Combined 30-day conservative minimum after protections; limiting date {liquidity.aggregate.limitingDate}. This is not spending cash from a chosen account. No automatic transfer from savings or other accounts.</p>
    <form method="get" className="mt-3 flex flex-wrap items-end gap-2"><label className="grid gap-1 text-sm">Paying account<select name="account" defaultValue={selected?.accountId ?? ""} className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-foreground"><option value="">Choose a paying account</option>{liquidity.accounts.map(account => <option key={account.accountId} value={account.accountId}>{names.get(account.accountId) ?? account.accountId}</option>)}</select></label><button className="min-h-10 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">Evaluate account</button></form>
    {accountId && !selected && <p role="alert" className="mt-2 text-sm">Choose a current liquid account.</p>}
    {selected && <div className="mt-3"><h3 className="text-sm font-semibold">Chosen-account headroom — {names.get(selected.accountId) ?? selected.accountId}</h3><p className="font-mono text-xl">{money(selected.amountMinor)}</p><p className="text-xs text-muted-foreground">Limiting date {selected.limitingDate}. Protected funds: {money(selected.protectedMinor)}. Spending must respect this account&apos;s obligations and protections.</p></div>}
    {liquidity.accounts.filter(account => account.shortfallMinor > 0n).map(account => <p key={account.accountId} role="alert" className="mt-3 text-sm font-medium">{names.get(account.accountId) ?? account.accountId} funding shortfall: {money(account.shortfallMinor)}. First shortfall {account.firstShortfallDate}; limiting date {account.limitingDate}. <Link href={`/plan?account=${encodeURIComponent(account.accountId)}`} className="text-brand underline">Review payments and funding</Link></p>)}
    <Link href={selected ? `/plan?account=${encodeURIComponent(selected.accountId)}` : "/plan"} className="mt-3 inline-block text-xs font-medium text-brand">Review forecast, protections and goals</Link>
  </div>;
}
