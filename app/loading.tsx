import { Skeleton, SkeletonCard, SkeletonTable } from "@/components/ui/skeleton";

export default function Loading() {
  return <main aria-busy="true" className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-8 lg:py-10">
    <p role="status" className="sr-only">Loading workspace…</p>
    <div className="space-y-2"><Skeleton className="h-7 w-48" /><Skeleton className="h-4 w-72 max-w-full" /></div>
    <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map(key => <SkeletonCard key={key} lines={1} />)}</div>
    <SkeletonTable />
  </main>;
}
