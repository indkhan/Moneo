// No server imports: Home's grid shows the same placeholder while an added widget loads.
export const card = "min-w-0 rounded-xl border border-border bg-card p-6 sm:p-7";

export function SectionFallback({ title }: { title: string }) {
  return <section aria-busy="true" className={card}><h2 className="text-sm font-medium">{title}</h2><p role="status" className="mt-3 text-sm text-muted-foreground">Loading…</p></section>;
}
