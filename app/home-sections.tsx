import Link from "next/link";
import { AskAbout } from "@/components/ask-about";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadHomeSpending } from "@/lib/finance/dashboard-spending";
import { displayFormat } from "@/lib/display-format";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import { CashFlowView } from "./cash-flow-view";

type SectionProps = { db: SupabaseClient; workspaceId: string; currency: string; today: string; locale: string };

import { card } from "./section-fallback";

/** A formatted amount with its minor units dimmed, like the design's hero figures. */
export function Figure({ value, digits, className }: { value: string; digits: number; className?: string }) {
  const match = digits > 0 ? value.match(new RegExp(`^(.*\\d)([.,]\\d{${digits}})(\\D*)$`)) : null;
  return <p className={className}>{match ? <>{match[1]}<span className="text-[0.5em] tracking-tight text-subtle">{match[2]}</span>{match[3]}</> : value}</p>;
}

const monthName = (from: string, locale: string, month: "short" | "long" = "long") => month === "short" ? displayFormat(locale).shortMonth(from) : displayFormat(locale).month(from);

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
          <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{displayFormat(locale).date(row.posted_on)}</span>
          <span className="min-w-0 flex-1"><span className="block truncate">{row.description ?? "Recorded posting"}</span><span className="block truncate text-xs text-muted-foreground">{names.get(row.account_id) ?? "Account"}{row.status === "pending" ? " · pending" : ""}{row.review_reasons?.length ? " · needs review" : ""}</span></span>
          <span className="shrink-0 font-mono">{formatMoney(row.amount_minor, row.currency_code, locale)}</span>
        </Link>
      </li>)}</ul>
      : <p className="mt-3 text-sm text-muted-foreground">No transactions yet. <Link href="/import" className="text-brand underline">Import a statement</Link>.</p>}
  </section>;
}
