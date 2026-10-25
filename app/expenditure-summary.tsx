import Link from "next/link";
import type { ReactNode } from "react";
import type { reportExpenditure } from "@/lib/finance/expenditure";
import { formatMoney } from "@/lib/finance/format";

export function ExpenditureSummary({ report, locale, accountId, coverage, title = "Spending this month", viewHref }: { report: ReturnType<typeof reportExpenditure>; locale: string; accountId?: string; coverage?: ReactNode; title?: string; viewHref?: (view: "base" | "original") => string }) {
  const money = (amount: string, currency: string) => formatMoney(amount, currency, locale);
  const href = (view: "base" | "original") => viewHref?.(view) ?? `/?${new URLSearchParams({ spendingView: view, ...(accountId ? { account: accountId } : {}) })}`;
  return <div className="space-y-4 rounded-xl border border-border bg-card p-6">
    <h2 className="text-sm font-medium">{title}</h2>
    <nav aria-label="Spending currency view" className="flex flex-wrap gap-4 text-sm">
      <Link href={href("base")} aria-current={report.view === "base" ? "page" : undefined} className="text-brand underline">Base currency ({report.currencyCode})</Link>
      <Link href={href("original")} aria-current={report.view === "original" ? "page" : undefined} className="text-brand underline">Original currencies</Link>
    </nav>
    {report.view === "base" && (report.totals ? <p className="font-mono text-2xl font-semibold">{money(report.totals.spendingMinor, report.currencyCode)}</p> : <div className="space-y-2"><p className="font-semibold text-amber-700">Incomplete base-currency report</p><p className="text-sm">Available converted subtotal: {money(report.availableTotals.spendingMinor, report.currencyCode)}</p><p className="text-sm text-muted-foreground">{report.limitation}</p></div>)}
    <p className="text-sm text-muted-foreground">{report.from} to {report.to}. Refunds are subtracted; pending items and transfers are left out.</p>
    {report.view === "original" && report.status === "incomplete" && <p className="text-sm text-amber-700">Incomplete: {report.limitation}</p>}
    <ul aria-label="Original currency spending subtotals" className="space-y-1 text-sm">{Object.entries(report.perCurrency).map(([currency, totals]) => <li key={currency}>{currency}: {money(totals.spendingMinor, currency)} original spending</li>)}</ul>
    {!Object.keys(report.perCurrency).length && <p className="text-sm text-muted-foreground">No reviewed posted spending or income in this period.</p>}
    {coverage}
    <details className="text-sm text-muted-foreground"><summary className="cursor-pointer text-brand">Conversion details and exclusions</summary>
      {report.view === "base" && <p className="mt-3">Exact posting-date direct FX rates; each canonical posting rounds half away from zero before aggregation. Category splits are combined; transfer fees remain separate from principal.</p>}
      <ul className="mt-3 space-y-2">{report.postings.map(posting => <li key={posting.id}>{posting.postedOn} · {money(posting.originalAmountMinor, posting.originalCurrencyCode)}{posting.reportingAmountMinor !== null && report.view === "base" ? ` → ${money(posting.reportingAmountMinor, report.currencyCode)}` : ""}{posting.version !== undefined ? ` · correction version ${posting.version}` : ""}{posting.rate && <span> · Rate {posting.rate.id ?? "identity"}, {posting.rate.source}, {posting.rate.date}, {posting.rate.numerator}/{posting.rate.denominator}; rounded minor units {posting.rounding?.roundedMinor} from {posting.rounding?.scaledNumerator}/{posting.rounding?.scaledDenominator}</span>}
        {posting.parentTransactionId && <p className="mt-1">Original posting <Link className="underline" href={`/money/transactions?transaction=${posting.parentTransactionId}`}>{posting.parentTransactionId}</Link>: {posting.parentAmountMinor === null ? "amount unavailable" : money(posting.parentAmountMinor, posting.originalCurrencyCode)} ({posting.parentAmountBasis === "canonical-record" ? "recorded original" : "sum of effective allocations"}). Allocations: {posting.sourcePostings.map(source => `${source.id}: ${money(source.originalAmountMinor, posting.originalCurrencyCode)}`).join("; ")}</p>}
      </li>)}</ul>
      <ul className="mt-2 space-y-1">{report.exclusions.map(item => <li key={`${item.id}:${item.reason}`}>{item.postedOn} · {money(item.originalAmountMinor, item.currencyCode)} · {item.reason}</li>)}</ul>
    </details>
    <Link href="/plan/spending" className="inline-block text-sm font-medium text-brand hover:underline">Review monthly spending plans</Link>
  </div>;
}
