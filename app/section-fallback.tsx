// No server imports: Home's grid shows the same placeholder while an added widget loads.
export const card = "min-w-0 rounded-xl border border-border bg-card p-6 sm:p-7";

/** `chart` reserves the height of the chart the section draws, so Home's widgets stay put when it arrives. */
export function SectionFallback({ title, chart }: { title: string; chart?: number }) {
  return <section aria-busy="true" className={card}><h2 className="text-sm font-medium">{title}</h2>
    <p role="status" className={chart ? "sr-only" : "mt-3 text-sm text-muted-foreground"}>Loading…</p>
    {chart && <div aria-hidden="true" className="mt-4 animate-pulse rounded-lg bg-muted" style={{ height: chart }} />}</section>;
}
