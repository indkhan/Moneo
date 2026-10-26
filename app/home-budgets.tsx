import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatMoney } from "@/lib/finance/format";
import { budgetsThisMonth, loadInsightEvidence } from "./insights/panel";
import { card } from "./home-sections";

/** This month's budgets in the display currency: spent of allowance, with what is left or over (see BACKLOG.md for other currencies). */
export async function HomeBudgets({ db, workspaceId, currency, today, locale }: { db: SupabaseClient; workspaceId: string; currency: string; today: string; locale: string }) {
  let rows;
  try { rows = budgetsThisMonth(await loadInsightEvidence(db, workspaceId, currency, today), today).filter(row => row.budget.currency_code === currency); } catch { rows = null; }
  const money = (amount: bigint) => formatMoney(amount, currency, locale);
  const daysLeft = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate() - Number(today.slice(8, 10)) + 1;
  const previousMonth = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)));
  return <section aria-labelledby="home-budgets" className={card}>
    <div className="flex items-baseline justify-between gap-2"><h2 id="home-budgets" className="text-sm font-medium">Budgets</h2><Link href="/plan/spending" className="text-xs font-medium text-brand underline">Manage</Link></div>
    {rows === null ? <p role="alert" className="mt-3 text-sm text-muted-foreground">Budgets are unavailable right now.</p>
      : !rows.length ? <p className="mt-3 text-sm text-muted-foreground">No budgets yet. <Link href="/plan/spending" className="text-brand underline">Set one up</Link>.</p>
      : <ul className="mt-4 space-y-5">{rows.map(({ budget, name, progress }) => {
        const { spentMinor, allowanceMinor, remainingMinor, carriedMinor } = progress;
        const over = remainingMinor !== null && remainingMinor < 0n;
        const share = allowanceMinor && allowanceMinor > 0n ? Math.min(100, Number(spentMinor * 100n / allowanceMinor)) : spentMinor > 0n ? 100 : 0;
        return <li key={budget.id}>
          <div className="flex items-baseline justify-between gap-3 text-sm"><Link href={`/money/transactions?${new URLSearchParams({ category: budget.category_id, from: `${today.slice(0, 7)}-01`, to: today, direction: "outflow" })}`} className="truncate font-medium hover:underline">{name}</Link>
            <span className={`shrink-0 font-mono text-xs ${over ? "text-warning" : ""}`}>{money(spentMinor)} / {allowanceMinor === null ? "?" : money(allowanceMinor)}</span></div>
          <span aria-hidden="true" className="mt-2 block h-1 rounded-full bg-muted"><span className={`block h-1 rounded-full ${over ? "bg-warning" : share >= 90 ? "bg-foreground" : "bg-brand"}`} style={{ width: `${share}%` }} /></span>
          <p className={`mt-1.5 text-xs ${over ? "text-warning" : "text-muted-foreground"}`}>
            {progress.limitation ? progress.limitation
              : over ? `${money(-remainingMinor!)} over`
              : carriedMinor ? `${money(remainingMinor!)} left · includes ${money(carriedMinor)} rolled over from ${previousMonth}`
              : share >= 75 ? `${money(remainingMinor!)} left for ${daysLeft} day${daysLeft === 1 ? "" : "s"}` : "On track"}
          </p>
        </li>;
      })}</ul>}
  </section>;
}
