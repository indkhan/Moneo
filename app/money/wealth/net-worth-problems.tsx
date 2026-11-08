import Link from "next/link";
import type { Discrepancy } from "@/lib/finance/net-worth-checks";

/** Problems that change the number stay listed here until the records are fixed. Nothing shows when everything adds up. */
export function NetWorthProblems({ findings }: { findings: Discrepancy[] }) {
  if (!findings.length) return null;
  return <section aria-labelledby="net-worth-problems" className="rounded-xl border border-border bg-card p-5 sm:p-6">
    <h2 id="net-worth-problems" className="text-sm font-medium">Needs a look</h2>
    <ul className="mt-2 divide-y divide-border text-sm">{findings.map(finding => <li key={finding.key} className="py-3">
      <p className="font-medium text-warning">{finding.title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{finding.detail}</p>
      <Link href={finding.href} className="mt-1 inline-flex min-h-11 items-center text-xs font-medium text-brand underline sm:min-h-0">See the records</Link>
    </li>)}</ul>
  </section>;
}
