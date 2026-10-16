export default function Loading() {
  return <main aria-busy="true" className="mx-auto w-full max-w-6xl space-y-8 px-4 py-8 sm:px-8 lg:py-10">
    <p role="status" className="text-sm text-muted-foreground">Loading workspace…</p>
    <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
      <div className="h-8 w-48 rounded-lg bg-muted" />
      <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map(key => <div key={key} className="h-28 rounded-xl border border-border bg-card" />)}</div>
      <div className="h-64 rounded-xl border border-border bg-card" />
    </div>
  </main>;
}
