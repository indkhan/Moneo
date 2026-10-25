import { Skeleton, SkeletonCard, SkeletonTable } from "@/components/skeleton";

export default function Loading() {
  return <main aria-busy="true" className="mx-auto w-full max-w-[1400px] space-y-6 px-4 py-6 sm:px-8 lg:py-8">
    <p role="status" className="sr-only">Loading workspace…</p>
    <div className="space-y-2"><Skeleton className="h-3 w-40" /><Skeleton className="h-11 w-64" /><Skeleton className="h-4 w-72 max-w-full" /></div>
    <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map(key => <SkeletonCard key={key} lines={1} />)}</div>
    <SkeletonTable />
  </main>;
}
