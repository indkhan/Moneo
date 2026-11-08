import Link from "next/link";
import { SafeForm } from "@/components/safe-form";
import { formatMoney } from "@/lib/finance/format";
import type { UnresolvedTransfer } from "@/lib/finance/transit";
import type { Discrepancy } from "@/lib/finance/net-worth-checks";
import { keepRepaymentSafely } from "./actions";

/** Problems that change the number stay listed here until the records are fixed. Nothing shows when everything adds up. */
export function NetWorthProblems({ findings, unresolved = [], locale }: { findings: Discrepancy[]; unresolved?: UnresolvedTransfer[]; locale?: string }) {
  if (!findings.length && !unresolved.length) return null;
  return <section aria-labelledby="net-worth-problems" className="rounded-xl border border-border bg-card p-5 sm:p-6">
    <h2 id="net-worth-problems" className="text-sm font-medium">Needs a look</h2>
    <ul className="mt-2 divide-y divide-border text-sm">{findings.map(finding => <li key={finding.key} className="py-3">
      <p className="font-medium text-warning">{finding.title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{finding.detail}</p>
      <div className="mt-1 flex flex-wrap items-center gap-4">
        <Link href={finding.href} className="inline-flex min-h-11 items-center text-xs font-medium text-brand underline sm:min-h-0">See the records</Link>
        {finding.repaymentId && <SafeForm action={keepRepaymentSafely}><input type="hidden" name="repaymentId" value={finding.repaymentId} /><button className="min-h-11 text-xs font-medium underline sm:min-h-0">It still stands</button></SafeForm>}
      </div>
    </li>)}</ul>
    {unresolved.length > 0 && <details className="mt-1 text-sm"><summary className="flex min-h-11 cursor-pointer items-center font-medium sm:min-h-0 sm:py-1">{unresolved.length === 1 ? "1 transfer has" : `${unresolved.length} transfers have`} one side so far</summary>
      <p className="mt-1 text-xs text-muted-foreground">Moneo leaves the total as it is, and earlier days correct themselves once the other side lands. If it went to a bank Moneo doesn&apos;t track, nothing more is needed.</p>
      <ul className="mt-2 divide-y divide-border">{unresolved.map(item => <li key={item.key} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 text-xs">
        <span className="min-w-0 break-words"><span className="font-mono text-muted-foreground">{item.date}</span> {item.label}{item.reason === "ambiguous" ? " · more than one possible match" : ""}</span>
        <span className="font-mono tabular-nums">{formatMoney(item.amountMinor, item.currencyCode, locale)}</span></li>)}</ul>
    </details>}
  </section>;
}
