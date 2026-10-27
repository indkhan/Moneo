import Link from "next/link";
import { AskAbout } from "@/components/ask-about";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadHomeSpending } from "@/lib/finance/dashboard-spending";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import { CashFlowLink, CashFlowView } from "./cash-flow-view";

type SectionProps = { db: SupabaseClient; workspaceId: string; currency: string; today: string; locale: string };

export const card = "min-w-0 rounded-xl border border-border bg-card p-6 sm:p-7";

/** A formatted amount with its minor units dimmed, like the design's hero figures. */
export function Figure({ value, digits, className }: { value: string; digits: number; className?: string }) {
  const match = digits > 0 ? value.match(new RegExp(`^(.*\\d)([.,]\\d{${digits}})(\\D*)$`)) : null;
  return <p className={className}>{match ? <>{match[1]}<span className="text-[0.5em] tracking-tight text-subtle">{match[2]}</span>{match[3]}</> : value}</p>;
}

export function SectionFallback({ title }: { title: string }) {
  return <section aria-busy="true" className={card}><h2 className="text-sm font-medium">{title}</h2><p role="status" className="mt-3 text-sm text-muted-foreground">Loading…</p></section>;
}

const monthName = (from: string, locale: string, month: "short" | "long" = "long") => new Intl.DateTimeFormat(locale, { month, timeZone: "UTC" }).format(new Date(`${from}T00:00:00Z`));

/** This month's money in, money out and what is left; In and Out open their breakdown in the six-month chart. */
export async function MonthCashFlow({ db, workspaceId, currency, today, locale, children }: SectionProps & { children?: ReactNode }) {
  let data;
  try { data = await loadHomeSpending(db, workspaceId, currency, today); } catch { data = null; }
  const days = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const header = <div className="flex items-baseline justify-between gap-2"><h2 className="text-sm font-medium">{monthName(today, locale)} cash flow</h2><span className="font-mono text-[11px] text-subtle">day {Number(today.slice(8, 10))} / {days}</span></div>;
  if (!data) return <section aria-label="Cash flow this month" className={`${card} flex flex-col gap-5`}>{header}<p role="alert" className="text-sm text-muted-foreground">Cash flow is unavailable right now.</p>{children}</section>;
  const { month, incomeMinor, spendingMinor } = data.thisMonth;
  const left = incomeMinor - spendingMinor;
  const outShare = incomeMinor > 0n ? Math.min(100, Number(spendingMinor * 100n / incomeMinor)) : spendingMinor > 0n ? 100 : 0;
  const row = (flow: "in" | "out", label: string, value: string, tone: string) => <CashFlowLink changes={{ month, flow }} className="-mx-2 flex items-baseline justify-between gap-3 rounded-lg px-2 py-1 hover:bg-muted">
    <span className="text-sm text-muted-foreground">{label}</span><span className={`font-mono text-xl ${tone}`}>{value}</span></CashFlowLink>;
  return <section aria-label="Cash flow this month" className={`${card} flex flex-col gap-4`}>
    {header}
    {row("in", "In", `+${formatMoney(incomeMinor, currency, locale)}`, "text-brand")}
    {row("out", "Out", formatMoney(-spendingMinor, currency, locale), "")}
    <div aria-hidden="true" className="flex h-1.5 gap-1"><span className={`rounded-full ${left < 0n ? "bg-warning" : "bg-chart-out"}`} style={{ width: `${outShare}%` }} />{outShare < 100 && <span className="flex-1 rounded-full bg-brand" />}</div>
    <div className="flex items-baseline justify-between gap-3 border-t border-border pt-5"><span className="text-sm text-muted-foreground">Left this month</span>
      <Figure value={formatMoney(left, currency, locale)} digits={minorDigits(currency)} className={`display-figure text-[32px] ${left < 0n ? "text-warning" : ""}`} /></div>
    {children}
  </section>;
}

/** Six months of money in vs out; the In/Out/month selection happens in the browser over this one read. */
export async function CashFlowPanel({ db, workspaceId, currency, today, locale }: SectionProps) {
  let data;
  try { data = await loadHomeSpending(db, workspaceId, currency, today); } catch { data = null; }
  const ask = <AskAbout question="How did my money in and out change over the last six months? What drove it?" about={{ kind: "chart", label: "Six-month cash flow" }} />;
  if (!data) return <section id="cash-flow" aria-label="Cash flow" className={card}><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">Cash flow · 6 months</h2>{ask}</div>
    <p role="alert" className="mt-3 text-sm">Cash flow is unavailable right now. Your balances are not affected.</p></section>;
  const months = data.months.map((month, index) => ({ ...month, label: monthName(month.from, locale, "short"), name: monthName(month.from, locale),
    incomeMinor: data.trend[index].incomeMinor, spendingMinor: data.trend[index].spendingMinor }));
  return <section id="cash-flow" aria-label="Cash flow" className={card}>
    <CashFlowView months={months} scale={10 ** minorDigits(currency)} categoryNames={Object.fromEntries(data.categoryNames)} merchantNames={Object.fromEntries(data.merchantNames)} currency={currency} locale={locale} ask={ask} />
  </section>;
}

export async function RecentTransactions({ db, workspaceId, locale, names }: Omit<SectionProps, "currency" | "today"> & { names: Map<string, string> }) {
  const { data, count, error } = await db.from("transactions").select("id, posted_on, description, amount_minor::text, currency_code, status, account_id, review_reasons", { count: "exact" })
    .eq("workspace_id", workspaceId).order("posted_on", { ascending: false }).order("id").limit(8);
  const rows = (data ?? []) as { id: string; posted_on: string; description: string | null; amount_minor: string; currency_code: string; status: string; account_id: string; review_reasons: string[] | null }[];
  return <section aria-label="Recent transactions" className={card}>
    <div className="flex items-baseline justify-between gap-2"><h2 className="text-sm font-medium">Recent transactions</h2><Link href="/money/transactions" className="text-sm font-medium text-brand hover:underline">All {count ?? 0}</Link></div>
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
