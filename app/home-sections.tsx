import Link from "next/link";
import { AskAbout } from "@/components/ask-about";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { loadHomeSpending } from "@/lib/finance/dashboard-spending";
import { displayFormat } from "@/lib/display-format";
import { formatMoney } from "@/lib/finance/format";
import { CashFlowView } from "./cash-flow-view";

type SectionProps = { db: SupabaseClient; workspaceId: string; currency: string; today: string; locale: string };

import { card } from "./section-fallback";

const PHONE_FIGURE_CHARACTERS = 12;

export function Figure({ value, compact, digits, className }: { value: string; compact: string; digits: number; className?: string }) {
  const match = digits > 0 ? value.match(new RegExp(`^(.*\\d)([.,]\\d{${digits}})(\\D*)$`)) : null;
  const full = match ? <>{match[1]}<span className="text-[0.5em] tracking-tight text-subtle">{match[2]}</span>{match[3]}</> : value;
  if (value.length <= PHONE_FIGURE_CHARACTERS) return <p className={`whitespace-nowrap tabular-nums ${className ?? ""}`}>{full}</p>;
  return <p title={value} className={`whitespace-nowrap tabular-nums ${className ?? ""}`}><span aria-hidden="true" className="sm:hidden">{compact}</span><span className="sr-only sm:not-sr-only">{full}</span></p>;
}

const monthName = (from: string, locale: string, month: "short" | "long" = "long") => month === "short" ? displayFormat(locale).shortMonth(from) : displayFormat(locale).month(from);

export async function CashFlowPanel({ data: spending, currency, locale }: Pick<SectionProps, "currency" | "locale"> & { data: ReturnType<typeof loadHomeSpending> }) {
  let data;
  try { data = await spending; } catch { data = null; }
  const ask = <AskAbout question="How did my money in and out change over the last six months? What drove it?" about={{ kind: "chart", label: "Six-month cash flow" }} />;
  if (!data) return <section id="cash-flow" aria-label="Cash flow" className={card}><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">Cash flow · 6 months</h2>{ask}</div>
    <p role="alert" className="mt-3 text-sm">Cash flow is unavailable right now. Your balances are not affected.</p></section>;
  if (data.history !== "in range") return <section id="cash-flow" aria-label="Cash flow" className={card}><h2 className="text-sm font-medium">Cash flow · 6 months</h2>
    <div className="mt-4 flex h-[240px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border px-4 text-center text-sm text-muted-foreground">
      {data.history === "none" ? <p>Import a statement or connect a bank to see cash flow.</p> : <p>No transactions in this period.</p>}
      {data.history === "none" && <p><Link href="/import" className="text-brand hover:underline">Import a statement</Link> · <Link href="/import#connected-banks" className="text-brand hover:underline">Connect a bank</Link></p>}
    </div></section>;
  const months = data.months.map((month, index) => ({ ...month, label: monthName(month.from, locale, "short"), name: monthName(month.from, locale),
    incomeMinor: data.trend[index].incomeMinor, spendingMinor: data.trend[index].spendingMinor }));
  return <section id="cash-flow" aria-label="Cash flow" className={card}>
    <CashFlowView months={months} categoryNames={Object.fromEntries(data.categoryNames)} merchantNames={Object.fromEntries(data.merchantNames)} currency={currency} locale={locale} ask={ask} />
  </section>;
}

export async function RecentTransactions({ db, workspaceId, locale, names: pendingNames }: Omit<SectionProps, "currency" | "today"> & { names: Promise<Map<string, string>> }) {
  const [{ data, count, error }, names] = await Promise.all([
    db.from("transactions").select("id, posted_on, description, amount_minor::text, currency_code, status, account_id, review_reasons", { count: "exact" })
      .eq("workspace_id", workspaceId).order("posted_on", { ascending: false }).order("id").limit(8),
    pendingNames,
  ]);
  const rows = (data ?? []) as { id: string; posted_on: string; description: string | null; amount_minor: string; currency_code: string; status: string; account_id: string; review_reasons: string[] | null }[];
  return <section aria-label="Recent transactions" className={card}>
    <div className="flex items-baseline justify-between gap-2"><h2 className="text-sm font-medium">Recent transactions</h2><Link href="/money/transactions" className="text-sm font-medium text-brand hover:underline">All {count ?? 0}</Link></div>
    {error ? <p role="alert" className="mt-3 text-sm">Recent transactions are unavailable right now.</p>
      : rows.length ? <ul className="mt-2 divide-y divide-border">{rows.map(row => <li key={row.id}>
        <Link href={`/money/transactions?transaction=${row.id}`} className="flex items-center gap-3 py-2 text-sm hover:bg-muted">
          <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{displayFormat(locale).date(row.posted_on)}</span>
          <span className="min-w-0 flex-1"><span title={row.description ?? undefined} className="line-clamp-2 break-words">{row.description ?? "Recorded posting"}</span><span className="block truncate text-xs text-muted-foreground">{names.get(row.account_id) ?? "Account"}{row.status === "pending" ? " · pending" : ""}{row.review_reasons?.length ? " · needs review" : ""}</span></span>
          <span className="shrink-0 whitespace-nowrap font-mono tabular-nums">{formatMoney(row.amount_minor, row.currency_code, locale)}</span>
        </Link>
      </li>)}</ul>
      : <p className="mt-3 text-sm text-muted-foreground">No transactions yet. <Link href="/import" className="text-brand underline">Import a statement</Link>.</p>}
  </section>;
}
