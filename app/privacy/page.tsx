import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy — Moneo",
  description: "How Moneo handles your data while the app is still being built.",
};

export default function PrivacyPage() {
  return (
    <main className="flex min-h-screen justify-center bg-background px-5 py-12">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2.5" aria-label="Moneo home">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">M</span>
            <span className="text-base font-semibold tracking-tight">Moneo</span>
          </Link>
        </div>
        <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
          <p className="eyebrow">Privacy</p>
          <h1 className="mt-2 page-title">Privacy notice</h1>
          <p className="mt-3 rounded-lg border border-amber-700/30 bg-amber-50 px-3 py-2 text-sm text-amber-700">
            Moneo is not launched yet and is still being built. This notice describes the current plan and will be updated before launch.
          </p>
          <div className="mt-6 space-y-5 text-sm leading-relaxed text-muted-foreground">
            <section>
              <h2 className="text-sm font-medium text-foreground">What Moneo is</h2>
              <p className="mt-1">Moneo is a personal-finance workspace for understanding your money, planning decisions, and building reusable tools with AI. You start with CSV/Excel imports and manual entries.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">Data you provide</h2>
              <p className="mt-1">Your email for sign-in, and any financial data you import or enter: accounts, transactions, balances, goals, budgets, and AI conversations.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">How your data is used</h2>
              <p className="mt-1">Only to run your private workspace: show balances and forecasts, run calculations from application code, and answer your AI questions. Financial calculations come from application code, not AI guesses.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">AI and third parties</h2>
              <p className="mt-1">When you use AI features, the minimum needed context is sent to the model provider (OpenAI or OpenRouter, depending on the model you choose) and to hosting/database providers (Supabase) to store your workspace. Bank connections, when added later, bring data in only — they never move money.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">What we do not do</h2>
              <p className="mt-1">No selling your data, no advertising use, no public sharing of your workspace. Original records are preserved with history and undo.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">Your control</h2>
              <p className="mt-1">You can review and correct your data in the app, manage AI access in settings, and request deletion of your workspace. Contact details will be published here before launch.</p>
            </section>
            <p className="text-xs">Last updated: October 2026 · This is a pre-launch draft, not legal advice.</p>
          </div>
        </div>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          <Link href="/terms" className="underline hover:text-foreground">Terms</Link>
          <span aria-hidden="true"> · </span>
          <Link href="/login" className="underline hover:text-foreground">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
