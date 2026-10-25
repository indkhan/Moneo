import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms — Moneo",
  description: "The basic terms for using Moneo while the app is still being built.",
};

export default function TermsPage() {
  return (
    <main className="flex min-h-screen justify-center bg-background px-5 py-12">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2.5" aria-label="Moneo home">
            <span className="flex size-8 items-center justify-center rounded-[10px] bg-lime font-display text-lg font-bold tracking-tighter text-[#0f1011]">m</span>
            <span className="font-display text-base font-semibold tracking-tight">Moneo</span>
          </Link>
        </div>
        <div className="rounded-2xl border border-border bg-card p-8">
          <p className="eyebrow">Terms</p>
          <h1 className="mt-2 page-title">Terms of use</h1>
          <p className="mt-3 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
            Moneo is not launched yet and is still being built. These draft terms will be finalized before launch.
          </p>
          <div className="mt-6 space-y-5 text-sm leading-relaxed text-muted-foreground">
            <section>
              <h2 className="text-sm font-medium text-foreground">The service</h2>
              <p className="mt-1">Moneo provides a private workspace to track accounts, transactions, goals, and plans, with optional AI assistance. Features may change or break during building.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">Your responsibilities</h2>
              <p className="mt-1">Provide accurate information, keep your sign-in link private, and only import data you have the right to use. You remain responsible for your financial decisions.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">No financial advice or money movement</h2>
              <p className="mt-1">Moneo shows calculations, forecasts, and AI suggestions for information only — not financial advice. Moneo never moves money: no payments, transfers, or trading. Future bank connections import data only.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">AI output</h2>
              <p className="mt-1">AI can make mistakes. Forecasts expose assumptions and missing information — check important figures against your source records before acting.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">Availability and changes</h2>
              <p className="mt-1">As a pre-launch app, Moneo may be unavailable, reset test data, or change features at any time. Final limits, pricing, and support terms will be published at launch.</p>
            </section>
            <p className="text-xs">Last updated: October 2026 · This is a pre-launch draft, not legal advice.</p>
          </div>
        </div>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          <Link href="/privacy" className="underline hover:text-foreground">Privacy</Link>
          <span aria-hidden="true"> · </span>
          <Link href="/login" className="underline hover:text-foreground">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
