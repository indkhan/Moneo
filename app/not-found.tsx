import Link from "next/link";

export default function NotFound() {
  return <main className="mx-auto flex w-full max-w-xl flex-col items-start gap-3 px-5 py-16">
    <p className="eyebrow">Not found</p>
    <h1 className="page-title">This page isn’t here</h1>
    <p className="text-sm text-muted-foreground">The link may be old, or what it pointed to may have been removed. Nothing has changed in your data.</p>
    <Link href="/" className="mt-2 min-h-10 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90">Go to Overview</Link>
  </main>;
}
