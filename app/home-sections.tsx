import Link from "next/link";
import { AskAbout } from "@/components/ask-about";
import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadHomeSpending } from "@/lib/finance/dashboard-spending";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import { TrendChart } from "./home-trend-chart";

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

type Flow = "in" | "out";
type Group = { id: string | null; incomeMinor: bigint; spendingMinor: bigint };
type Search = Record<string, string | undefined>;
const flowOf = (value?: string): Flow | undefined => value === "in" || value === "out" ? value : undefined;
const monthName = (from: string, locale: string, month: "short" | "long" = "long") => new Intl.DateTimeFormat(locale, { month, timeZone: "UTC" }).format(new Date(`${from}T00:00:00Z`));
const flowHref = (search: Search, changes: Search) => {
  const next = new URLSearchParams(Object.entries({ ...search, ...changes }).filter((entry): entry is [string, string] => Boolean(entry[1])));
  return `?${next}#cash-flow`;
};

/** This month's money in, money out and what is left; In and Out open their breakdown in the six-month chart. */
export async function MonthCashFlow({ db, workspaceId, currency, today, locale, search = {}, children }: SectionProps & { search?: Search; children?: ReactNode }) {
  let data;
  try { data = await loadHomeSpending(db, workspaceId, currency, today); } catch { data = null; }
  const days = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const header = <div className="flex items-baseline justify-between gap-2"><h2 className="text-sm font-medium">{monthName(today, locale)} cash flow</h2><span className="font-mono text-[11px] text-subtle">day {Number(today.slice(8, 10))} / {days}</span></div>;
  if (!data) return <section aria-label="Cash flow this month" className={`${card} flex flex-col gap-5`}>{header}<p role="alert" className="text-sm text-muted-foreground">Cash flow is unavailable right now.</p>{children}</section>;
  const { month, incomeMinor, spendingMinor } = data.thisMonth;
  const left = incomeMinor - spendingMinor;
  const outShare = incomeMinor > 0n ? Math.min(100, Number(spendingMinor * 100n / incomeMinor)) : spendingMinor > 0n ? 100 : 0;
  const row = (flow: Flow, label: string, value: string, tone: string) => <Link href={flowHref(search, { month, flow })} scroll={false} className="-mx-2 flex items-baseline justify-between gap-3 rounded-lg px-2 py-1 hover:bg-muted">
    <span className="text-sm text-muted-foreground">{label}</span><span className={`font-mono text-xl ${tone}`}>{value}</span></Link>;
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

function TopList({ title, groups, metric, names, param, from, to, currency, locale, unknown }: {
  title: string; groups: Group[]; metric: "incomeMinor" | "spendingMinor"; names: Map<string, string>; param: "category" | "merchant"; from: string; to: string; currency: string; locale: string; unknown: string;
}) {
  const max = groups[0]?.[metric] ?? 0n;
  return <div className="min-w-0">
    <h3 className="text-sm font-semibold">{title}</h3>
    {groups.length ? <ul className="mt-2 space-y-1">{groups.map(group => <li key={group.id ?? "none"}>
      <Link href={`/money/transactions?${new URLSearchParams({ [param]: group.id ?? "none", from, to, direction: metric === "incomeMinor" ? "income" : "outflow" })}`} className="group block rounded-md px-2 py-1.5 hover:bg-muted">
        <span className="flex justify-between gap-3 text-sm"><span className="truncate group-hover:underline">{group.id ? names.get(group.id) ?? unknown : unknown}</span><span className="shrink-0 font-mono">{formatMoney(group[metric], currency, locale)}</span></span>
        <span aria-hidden="true" className="mt-1 block h-1 rounded-full bg-muted"><span className={`block h-1 rounded-full ${metric === "incomeMinor" ? "bg-brand" : "bg-chart-out"}`} style={{ width: `${max > 0n ? Number(group[metric] * 100n / max) : 0}%` }} /></span>
      </Link>
    </li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">Nothing reviewed yet.</p>}
  </div>;
}

/** Six months of money in vs out. Picking In or Out shows only that side and where it came from or went. */
export async function CashFlowPanel({ db, workspaceId, currency, today, locale, search = {} }: SectionProps & { search?: Search }) {
  let data;
  try { data = await loadHomeSpending(db, workspaceId, currency, today); } catch { data = null; }
  // `show` is which bars are drawn and changes only from these buttons; `flow` is which breakdown is open below.
  const show = flowOf(search.show), flow = flowOf(search.flow);
  const legend = <span role="group" aria-label="Show" className="inline-flex rounded-lg border border-border p-0.5">
    {([[undefined, "Both", null], ["in", "In", "bg-brand"], ["out", "Out", "bg-chart-out"]] as const).map(([key, label, swatch]) =>
      <Link key={label} href={flowHref(search, { show: key, flow: key ?? flow })} scroll={false} aria-pressed={show === key}
        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${show === key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
        {swatch && <span aria-hidden="true" className={`size-2 rounded-sm ${swatch}`} />}{label}</Link>)}
  </span>;
  const header = <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">Cash flow · 6 months</h2>
    <span className="flex items-center gap-2">{legend}<AskAbout question="How did my money in and out change over the last six months? What drove it?" about={{ kind: "chart", label: "Six-month cash flow" }} /></span></div>;
  if (!data) return <section id="cash-flow" aria-label="Cash flow" className={card}>{header}<p role="alert" className="mt-3 text-sm">Cash flow is unavailable right now. Your balances are not affected.</p></section>;
  const scale = 10 ** minorDigits(currency);
  const selected = data.months.find(row => row.month === search.month) ?? data.months[data.months.length - 1];
  const when = `in ${monthName(selected.from, locale)}`;
  const lists = { currency, locale, from: selected.from, to: selected.to };
  return <section id="cash-flow" aria-label="Cash flow" className={card}>
    {header}
    <div className="mt-4"><TrendChart height={240} flow={show} selected={flow ? data.months.indexOf(selected) : undefined} months={data.trend.map(row => row.month)} labels={data.trend.map(row => monthName(row.from, locale, "short"))}
      income={data.trend.map(row => Number(row.incomeMinor) / scale)} spending={data.trend.map(row => Number(row.spendingMinor) / scale)} /></div>
    {flow === "in" && <div className="mt-5 grid gap-6 border-t border-border pt-5 md:grid-cols-2">
      <TopList title={`Where money came from ${when}`} groups={selected.incomeMerchants} metric="incomeMinor" names={data.merchantNames} param="merchant" unknown="Unknown source" {...lists} />
      <TopList title={`Income by category ${when}`} groups={selected.incomeCategories} metric="incomeMinor" names={data.categoryNames} param="category" unknown="Uncategorized" {...lists} />
    </div>}
    {flow === "out" && <div className="mt-5 grid gap-6 border-t border-border pt-5 md:grid-cols-2">
      <TopList title={`Top categories ${when}`} groups={selected.categories} metric="spendingMinor" names={data.categoryNames} param="category" unknown="Uncategorized" {...lists} />
      <TopList title={`Top merchants ${when}`} groups={selected.merchants} metric="spendingMinor" names={data.merchantNames} param="merchant" unknown="Unknown merchant" {...lists} />
    </div>}
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
