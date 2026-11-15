import Link from "next/link";

export function CoverageNote({ counted, total }: { counted: number; total: number }) {
  const left = total - counted;
  if (left <= 0) return null;
  return <p className="text-sm text-warning">From {counted} of {total} accounts. <Link href="/money/accounts#needs-balance" className="font-medium underline underline-offset-2">Fix {left === 1 ? "1 balance" : `${left} balances`}</Link></p>;
}
