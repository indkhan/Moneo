import Link from "next/link";

/** Beside any total that leaves accounts out, at reading size: a partial figure must never pass for the whole. */
export function CoverageNote({ counted, total }: { counted: number; total: number }) {
  const left = total - counted;
  if (left <= 0) return null;
  return <p className="text-sm text-warning">From {counted} of {total} accounts. <Link href="/money/accounts#needs-balance" className="font-medium underline underline-offset-2">Fix {left === 1 ? "1 balance" : `${left} balances`}</Link></p>;
}
