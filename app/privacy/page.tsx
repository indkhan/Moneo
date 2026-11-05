import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy",
  description: "How Moneo handles your data while the app is still being built.",
};

export default function PrivacyPage() {
  return (
    <main className="flex min-h-screen justify-center bg-background px-5 py-12">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2.5" aria-label="Moneo home">
            <span className="flex size-8 items-center justify-center rounded-[10px] bg-lime font-display text-lg font-bold tracking-tighter text-[#0f1011]">m</span>
            <span className="font-display text-base font-semibold tracking-tight">Moneo</span>
          </Link>
        </div>
        <div className="rounded-2xl border border-border bg-card p-5 sm:p-8">
          <p className="eyebrow">Privacy</p>
          <h1 className="mt-2 page-title">Privacy notice</h1>
          <p className="mt-3 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
            Moneo is not launched yet and is still being built. This notice describes the current plan and will be updated before launch.
          </p>
          <div className="mt-6 space-y-5 text-sm leading-relaxed text-muted-foreground">
            <section>
              <h2 className="text-sm font-medium text-foreground">What Moneo is</h2>
              <p className="mt-1">Moneo is a personal-finance workspace for understanding your money, planning decisions, and building reusable tools with AI. You add data with CSV/Excel imports, manual entries, or a read-only bank connection.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">Data you provide</h2>
              <p className="mt-1">Your email for sign-in, and any financial data you import or enter: accounts, transactions, balances, goals, budgets, AI conversations, and voice calls with Moneo. If you connect a bank, also the balances and booked transactions it shares.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">How your data is used</h2>
              <p className="mt-1">Only to run your private workspace: show balances and forecasts, run calculations from application code, and answer your AI questions. Financial calculations come from application code, not AI guesses.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">AI and third parties</h2>
              <p className="mt-1">When you use AI features, the context needed to answer is sent to the model provider (OpenAI or OpenRouter, depending on the model you choose); voice calls send your audio to OpenAI. Mapping an import can send its column headers and up to eight sample rows. <Link href="/settings#ai" className="underline hover:text-foreground">Settings</Link> controls what AI can read. Your workspace is stored with our hosting and database providers (Vercel and Supabase). Bank connections run through Enable Banking with your consent. They bring data in only and never move money, and you can disconnect them in <Link href="/settings#banks" className="underline hover:text-foreground">Settings</Link>.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">What we do not do</h2>
              <p className="mt-1">No selling your data, no advertising use, no public sharing of your workspace. Original records are preserved with history and undo.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">Keeping and deleting your data</h2>
              <p className="mt-1">Your data is kept until you remove it. <strong className="font-medium text-foreground">Reset all data</strong> empties your workspace and keeps your account. <strong className="font-medium text-foreground">Delete account</strong> permanently removes your account, your workspace, your uploaded files and your bank connections. Both are in <Link href="/settings#danger" className="underline hover:text-foreground">Settings</Link>.</p>
            </section>
            <section>
              <h2 className="text-sm font-medium text-foreground">Contact</h2>
              <p className="mt-1">For a question about your data, or if you can no longer sign in and want your account deleted, email <a href="mailto:mgsukhan@gmail.com" className="underline hover:text-foreground">mgsukhan@gmail.com</a>.</p>
            </section>
            <p className="text-xs">Last updated: 4 November 2026 · This is a pre-launch draft, not legal advice.</p>
          </div>
        </div>
        <p className="mt-4 flex flex-wrap items-center justify-center gap-x-1 text-sm text-muted-foreground">
          <Link href="/terms" className="inline-flex min-h-11 items-center px-2 underline hover:text-foreground">Terms</Link>
          <span aria-hidden="true"> · </span>
          <Link href="/" className="inline-flex min-h-11 items-center px-2 underline hover:text-foreground">Back to Moneo</Link>
        </p>
      </div>
    </main>
  );
}
