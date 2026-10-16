import { cn } from "@/lib/utils";

// Decorative placeholders: pair them with one visible or sr-only status message per region.
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("rounded-md bg-muted motion-safe:animate-pulse", className)} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return <div aria-hidden="true" className={cn("space-y-2", className)}>
    {Array.from({ length: lines }, (_, index) => <Skeleton key={index} className={cn("h-3.5", index === lines - 1 && lines > 1 ? "w-3/5" : "w-full")} />)}
  </div>;
}

export function SkeletonCard({ className, lines = 2 }: { className?: string; lines?: number }) {
  return <div aria-hidden="true" className={cn("space-y-4 rounded-xl border border-border bg-card p-5", className)}>
    <Skeleton className="h-4 w-1/3" />
    <SkeletonText lines={lines} />
  </div>;
}

export function SkeletonTable({ rows = 6, columns = 4, className }: { rows?: number; columns?: number; className?: string }) {
  return <div aria-hidden="true" className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
    <div className="flex gap-4 border-b border-border bg-muted/50 px-4 py-3">{Array.from({ length: columns }, (_, index) => <Skeleton key={index} className="h-3 flex-1" />)}</div>
    {Array.from({ length: rows }, (_, row) => <div key={row} className="flex gap-4 border-b border-border px-4 py-3.5 last:border-0">
      {Array.from({ length: columns }, (_, index) => <Skeleton key={index} className={cn("h-3.5 flex-1", index === columns - 1 && "max-w-24 ml-auto")} />)}
    </div>)}
  </div>;
}
