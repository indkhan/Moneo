import Link from "next/link";
import type { ReactNode } from "react";
import type { accountLiquidity } from "@/lib/finance/calculations";
import { describeMissingInputs, formatMoney } from "@/lib/finance/format";

export function HomeLiquidity({ liquidity, accountId, names, locale, coverage }: {
  liquidity: ReturnType<typeof accountLiquidity>; accountId?: string; names: Map<string, string>; locale?: string; coverage?: ReactNode;
}) {
  const card = "min-w-0 space-y-4 rounded-xl border border-border bg-card p-5";
  if (liquidity.status === "unavailable") return <div className={card}><h2 className="text-base font-semibold">Spending headroom</h2><p className="text-sm text-muted-foreground">Not available yet.</p><ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{describeMissingInputs(liquidity.missingInputs, names).map(item => <li key={item}>{item}</li>)}</ul>{coverage}<Link href="/plan" className="inline-block text-sm font-medium text-brand hover:underline">Open plan</Link></div>;
  const selected = liquidity.accounts.find(account => account.accountId === accountId);
  const money = (amount: bigint) => formatMoney(amount, liquidity.currencyCode, locale);
  return <div className={card}>
    <h2 className="text-base font-semibold">Aggregate headroom</h2>
    <div>
      <p className="font-mono text-2xl font-semibold">{money(liquidity.aggregate.amountMinor)}</p>
      <p className="mt-1 text-sm text-muted-foreground">Workspace buffer: {money(liquidity.workspaceBufferMinor)}, kept once across all accounts. Spending from one account is limited by both account liquidity and aggregate headroom.</p>
    </div>
    {liquidity.workspaceBufferPressureMinor > 0n && <p role="alert" className="text-sm">Workspace buffer pressure: {money(liquidity.workspaceBufferPressureMinor)} on {liquidity.aggregate.limitingDate}. This is separate from a paying-account funding shortfall.</p>}
    <details className="text-sm text-muted-foreground"><summary className="cursor-pointer hover:text-foreground">More details</summary><p className="mt-2">Lowest combined balance over the next 30 days after protections; limiting date {liquidity.aggregate.limitingDate}. No automatic transfer from savings or other accounts.</p></details>
    <form method="get" className="flex flex-wrap items-end gap-3"><label className="grid gap-1 text-sm font-medium">Paying account<select name="account" defaultValue={selected?.accountId ?? ""} className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal text-foreground"><option value="">Choose a paying account</option>{liquidity.accounts.map(account => <option key={account.accountId} value={account.accountId}>{names.get(account.accountId) ?? account.accountId}</option>)}</select></label><button className="min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Evaluate account</button></form>
    {accountId && !selected && <p role="alert" className="text-sm">Choose a current liquid account.</p>}
    {selected && <div className="space-y-1"><h3 className="text-sm font-semibold">Chosen-account headroom — {names.get(selected.accountId) ?? selected.accountId}</h3><p className="font-mono text-xl">{money(selected.spendableMinor)}</p><p className="text-sm text-muted-foreground">Protected funds: {money(selected.protectedMinor)}. Account liquidity: {money(selected.amountMinor)} on {selected.limitingDate}. Limiting date {selected.spendingLimitingDate}.</p></div>}
    {liquidity.accounts.filter(account => account.shortfallMinor > 0n).map(account => <p key={account.accountId} role="alert" className="text-sm font-medium">{names.get(account.accountId) ?? account.accountId} funding shortfall: {money(account.shortfallMinor)}. First shortfall {account.firstShortfallDate}; limiting date {account.limitingDate}. <Link href={`/plan?account=${encodeURIComponent(account.accountId)}`} className="text-brand underline">Review payments and funding</Link></p>)}
    {coverage}
    <Link href={selected ? `/plan?account=${encodeURIComponent(selected.accountId)}` : "/plan"} className="inline-block text-sm font-medium text-brand hover:underline">Review forecast, protections and goals</Link>
  </div>;
}
