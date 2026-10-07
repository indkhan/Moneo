import Link from "next/link";
import type { ReactNode } from "react";
import type { reportExpenditure } from "@/lib/finance/expenditure";
import { formatMoney } from "@/lib/finance/format";

export function ExpenditureSummary({ report, locale, accountId, coverage }: { report: ReturnType<typeof reportExpenditure>; locale: string; accountId?: string; coverage?: ReactNode }) {
  const money = (amount: string, currency: string) => formatMoney(amount, currency, locale);
  const href = (view: string) => `/?${new URLSearchParams({ spendingView: view, ...(accountId ? { account: accountId } : {}) })}`;
  return <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
    <h2 className="text-base font-semibold">Spending this month</h2>
    <nav aria-label="Spending currency view" className="mt-2 flex flex-wrap gap-3 text-xs">
      <Link href={href("base")} aria-current={report.view === "base" ? "page" : undefined} className="text-brand underline">Base currency ({report.currencyCode})</Link>
      <Link href={href("original")} aria-current={report.view === "original" ? "page" : undefined} className="text-brand underline">Original currencies</Link>
    </nav>
    {report.view === "base" && (report.totals ? <p className="mt-3 font-mono text-2xl font-semibold">{money(report.totals.spendingMinor, report.currencyCode)}</p> : <><p className="mt-3 font-semibold text-amber-700">Incomplete base-currency report</p><p className="mt-2 text-sm">Available converted subtotal: {money(report.availableTotals.spendingMinor, report.currencyCode)}</p><p className="mt-2 text-xs text-muted-foreground">{report.limitation}</p></>)}
    <p className="mt-2 text-xs text-muted-foreground">{report.from} to {report.to}; accepted reviewed postings, net of refunds. Pending and transfer principal excluded. Statement completeness is not established.</p>
    {report.view === "base" && <p className="mt-2 text-xs text-muted-foreground">Exact posting-date direct FX rates; each posting rounds half away from zero before aggregation.</p>}
    {report.view === "original" && report.status === "incomplete" && <p className="mt-2 text-xs text-amber-700">Incomplete: {report.limitation}</p>}
    <ul aria-label="Original currency spending subtotals" className="mt-3 space-y-1 text-sm">{Object.entries(report.perCurrency).map(([currency, totals]) => <li key={currency}>{currency}: {money(totals.spendingMinor, currency)} original spending</li>)}</ul>
    {!Object.keys(report.perCurrency).length && <p className="mt-3 text-sm text-muted-foreground">No reviewed posted spending or income in this period.</p>}
    {coverage}
    <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer text-brand">Conversion evidence and exclusions</summary>
      <ul className="mt-2 space-y-2">{report.postings.map(posting => <li key={posting.id}>{posting.postedOn} · {money(posting.originalAmountMinor, posting.originalCurrencyCode)}{posting.reportingAmountMinor !== null && report.view === "base" ? ` → ${money(posting.reportingAmountMinor, report.currencyCode)}` : ""}{posting.version !== undefined ? ` · correction version ${posting.version}` : ""}{posting.rate && <span> · Rate {posting.rate.id ?? "identity"}, {posting.rate.source}, {posting.rate.date}, {posting.rate.numerator}/{posting.rate.denominator}; rounded minor units {posting.rounding?.roundedMinor} from {posting.rounding?.scaledNumerator}/{posting.rounding?.scaledDenominator}</span>}</li>)}</ul>
      <ul className="mt-2 space-y-1">{report.exclusions.map(item => <li key={`${item.id}:${item.reason}`}>{item.postedOn} · {money(item.originalAmountMinor, item.currencyCode)} · {item.reason}</li>)}</ul>
    </details>
    <Link href="/plan/spending" className="mt-3 inline-block text-xs font-medium text-brand">Review monthly spending plans</Link>
  </div>;
}
