"use client";

import Link from "next/link";

export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <main className="mx-auto flex w-full max-w-xl flex-col items-start gap-3 px-5 py-16">
    <p className="eyebrow">Something went wrong</p>
    <h1 className="page-title">This page couldn’t load</h1>
    <p className="text-sm text-muted-foreground">Your data is safe. This is usually temporary, so try again.</p>
    <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" onClick={retry} className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">Try again</button>
      <Link href="/" className="min-h-10 rounded-lg border border-border px-4 py-2.5 text-sm font-medium hover:bg-muted">Go to Overview</Link>
    </div>
    {error.digest && <p className="mt-2 font-mono text-xs text-muted-foreground">Reference {error.digest}</p>}
  </main>;
}
