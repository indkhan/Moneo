export default function Loading() {
  return <main aria-busy="true" className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
    <p role="status" className="text-sm text-muted-foreground">Loading workspace…</p>
    <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
      <div className="h-8 w-48 rounded-lg bg-muted" />
      <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map(key => <div key={key} className="h-28 rounded-xl border border-border bg-card" />)}</div>
      <div className="h-64 rounded-xl border border-border bg-card" />
    </div>
  </main>;
}
