import Link from "next/link";

/** Up to five page numbers around the current one, shifted at the ends so five still show. */
export function pageWindow(page: number, pageCount: number, size = 5): number[] {
  const start = Math.max(1, Math.min(page - Math.floor(size / 2), pageCount - size + 1));
  return Array.from({ length: Math.min(size, pageCount) }, (_, index) => start + index);
}

/** First, Previous, a few page numbers, Next and Last. Steps that would go nowhere show disabled. */
export function LedgerPagination({ page, pageCount, href }: { page: number; pageCount: number; href: (page: number) => string }) {
  if (pageCount <= 1) return null;
  const base = "inline-flex h-9 min-w-9 items-center justify-center rounded-lg px-2.5 text-[13px]";
  const step = (label: string, to: number, disabled: boolean) => disabled
    ? <span aria-disabled="true" className={`${base} text-muted-foreground/50`}>{label}</span>
    : <Link href={href(to)} className={`${base} text-muted-foreground hover:bg-muted hover:text-foreground`}>{label}</Link>;
  return <nav aria-label="Pages" className="flex flex-wrap items-center gap-1">
    {step("First", 1, page === 1)}
    {step("Previous", page - 1, page === 1)}
    {pageWindow(page, pageCount).map(number => number === page
      ? <span key={number} aria-current="page" className={`${base} bg-foreground font-medium text-background`}>{number}</span>
      : <Link key={number} href={href(number)} aria-label={`Page ${number}`} className={`${base} text-muted-foreground hover:bg-muted hover:text-foreground`}>{number}</Link>)}
    {step("Next", page + 1, page >= pageCount)}
    {step("Last", pageCount, page >= pageCount)}
  </nav>;
}
