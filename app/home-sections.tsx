import Link from "next/link";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadHomeSpending } from "@/lib/dashboard-spending";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import { TrendChart } from "./home-trend-chart";

type SectionProps = { db: SupabaseClient; workspaceId: string; currency: string; today: string; locale: string };

export const card = "min-w-0 rounded-xl border border-border bg-card p-5";

export function Kpi({ label, href, action, children }: { label: string; href?: string; action?: string; children: ReactNode }) {
  return <div className="min-w-0 rounded-xl border border-border bg-card p-4">
    <div className="flex items-baseline justify-between gap-2"><p className="text-sm font-medium text-muted-foreground">{label}</p>{href && <Link href={href} className="text-xs font-medium text-brand hover:underline">{action ?? "Details"}</Link>}</div>
    {children}
  </div>;
}

export function KpiFallback({ label }: { label: string }) {
  return <Kpi label={label}><p role="status" className="mt-2 h-8 w-32 animate-pulse rounded bg-muted"><span className="sr-only">Loading</span></p></Kpi>;
}

export function SectionFallback({ title }: { title: string }) {
  return <section aria-busy="true" className={card}><h2 className="text-base font-semibold">{title}</h2><p role="status" className="mt-3 text-sm text-muted-foreground">Loading…</p></section>;
}

const sign = (amount: bigint) => amount < 0n ? -amount : amount;

export async function MonthSpendingKpi({ db, workspaceId, currency, today, locale }: SectionProps) {
  let data;
  try { data = await loadHomeSpending(db, workspaceId, currency, today); } catch { data = null; }
  if (!data) return <Kpi label="Spent this month" href="/plan/spending"><p className="mt-2 text-sm text-muted-foreground">Spending is unavailable right now.</p></Kpi>;
  const { thisMonth, lastMonthToDate } = data;
  const change = thisMonth.spendingMinor - lastMonthToDate.spendingMinor;
  const percent = lastMonthToDate.spendingMinor > 0n ? Number(sign(change) * 100n / lastMonthToDate.spendingMinor) : null;
  return <Kpi label="Spent this month" href="/plan/spending" action="Plans">
    <p className="mt-1 font-mono text-2xl font-semibold tracking-tight">{formatMoney(thisMonth.spendingMinor, currency, locale)}{thisMonth.partial && <span className="ml-2 align-middle text-xs font-normal text-amber-700">Partial</span>}</p>
    <p className="mt-1 text-xs text-muted-foreground">vs {formatMoney(lastMonthToDate.spendingMinor, currency, locale)} by this day last month{lastMonthToDate.partial ? " (partial)" : ""}{percent !== null && change !== 0n ? ` · ${change > 0n ? "up" : "down"} ${percent}%` : ""}</p>
  </Kpi>;
}

function TopList({ title, groups, names, param, from, to, currency, locale, unknown }: {
  title: string; groups: { id: string | null; spendingMinor: bigint; partial: boolean }[]; names: Map<string, string>; param: "category" | "merchant"; from: string; to: string; currency: string; locale: string; unknown: string;
}) {
  const max = groups[0]?.spendingMinor ?? 0n;
  return <div className="min-w-0">
    <h3 className="text-sm font-semibold">{title}</h3>
    {groups.length ? <ul className="mt-2 space-y-1">{groups.map(group => <li key={group.id ?? "none"}>
      <Link href={`/money/transactions?${new URLSearchParams({ [param]: group.id ?? "none", from, to, direction: "outflow" })}`} className="group block rounded-md px-2 py-1.5 hover:bg-muted">
        <span className="flex justify-between gap-3 text-sm"><span className="truncate group-hover:underline">{group.id ? names.get(group.id) ?? unknown : unknown}</span><span className="shrink-0 font-mono">{formatMoney(group.spendingMinor, currency, locale)}{group.partial ? "*" : ""}</span></span>
        <span aria-hidden="true" className="mt-1 block h-1 rounded-full bg-muted"><span className="block h-1 rounded-full bg-brand" style={{ width: `${max > 0n ? Number(group.spendingMinor * 100n / max) : 0}%` }} /></span>
      </Link>
    </li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">No reviewed spending yet this month.</p>}
  </div>;
}

export async function SpendingPanel({ db, workspaceId, currency, today, locale }: SectionProps) {
  let data;
  try { data = await loadHomeSpending(db, workspaceId, currency, today); } catch { data = null; }
  const header = <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-base font-semibold">Spending</h2><Link href="/money/transactions?direction=outflow" className="text-sm font-medium text-brand hover:underline">All spending</Link></div>;
  if (!data) return <section aria-label="Spending" className={card}>{header}<p role="alert" className="mt-3 text-sm">Spending is unavailable right now. Your balances are not affected.</p></section>;
  const month = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  const scale = 10 ** minorDigits(currency);
  const partial = data.trend.some(row => row.partial) || data.categories.some(row => row.partial);
  return <section aria-label="Spending" className={card}>
    {header}
    <p className="mt-1 text-xs text-muted-foreground">Last six months in {currency}. Refunds are subtracted; pending items, transfers and items needing review are left out.</p>
    <div className="mt-3"><TrendChart height={200} labels={data.trend.map(row => month.format(new Date(`${row.from}T00:00:00Z`)))} values={data.trend.map(row => Number(row.spendingMinor) / scale)} /></div>
    {partial && <p className="mt-2 text-xs text-amber-700">* Partial: some rows need review or an exchange rate for their posting date.</p>}
    <div className="mt-4 grid gap-6 md:grid-cols-2">
      <TopList title="Top categories this month" groups={data.categories} names={data.categoryNames} param="category" from={data.thisMonth.from} to={today} currency={currency} locale={locale} unknown="Uncategorized" />
      <TopList title="Top merchants this month" groups={data.merchants} names={data.merchantNames} param="merchant" from={data.thisMonth.from} to={today} currency={currency} locale={locale} unknown="Unknown merchant" />
    </div>
  </section>;
}

export async function RecentTransactions({ db, workspaceId, locale, names }: Omit<SectionProps, "currency" | "today"> & { names: Map<string, string> }) {
  const { data, count, error } = await db.from("transactions").select("id, posted_on, description, amount_minor::text, currency_code, status, account_id, review_reasons", { count: "exact" })
    .eq("workspace_id", workspaceId).order("posted_on", { ascending: false }).order("id").limit(8);
  const rows = (data ?? []) as { id: string; posted_on: string; description: string | null; amount_minor: string; currency_code: string; status: string; account_id: string; review_reasons: string[] | null }[];
  return <section aria-label="Recent transactions" className={card}>
    <div className="flex items-baseline justify-between gap-2"><h2 className="text-base font-semibold">Recent transactions</h2><Link href="/money/transactions" className="text-sm font-medium text-brand hover:underline">All {count ?? 0}</Link></div>
    {error ? <p role="alert" className="mt-3 text-sm">Recent transactions are unavailable right now.</p>
      : rows.length ? <ul className="mt-2 divide-y divide-border">{rows.map(row => <li key={row.id}>
        <Link href={`/money/transactions?transaction=${row.id}`} className="flex items-center gap-3 py-2 text-sm hover:bg-muted">
          <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{row.posted_on}</span>
          <span className="min-w-0 flex-1"><span className="block truncate">{row.description ?? "Recorded posting"}</span><span className="block truncate text-xs text-muted-foreground">{names.get(row.account_id) ?? "Account"}{row.status === "pending" ? " · pending" : ""}{row.review_reasons?.length ? " · needs review" : ""}</span></span>
          <span className="shrink-0 font-mono">{formatMoney(row.amount_minor, row.currency_code, locale)}</span>
        </Link>
      </li>)}</ul>
      : <p className="mt-3 text-sm text-muted-foreground">No transactions yet. <Link href="/import" className="text-brand underline">Import a statement</Link>.</p>}
  </section>;
}
