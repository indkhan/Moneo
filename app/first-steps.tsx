import Link from "next/link";
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import type { FirstRun } from "@/lib/first-run";
import { StartAgentRun } from "./ai/agents/start-run";
import { SkipAiSetup } from "./skip-ai-setup";
import { card } from "./section-fallback";

const primary = "inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 sm:min-h-9";
const secondary = "inline-flex min-h-11 items-center rounded-lg border border-input px-4 text-sm font-medium hover:bg-muted sm:min-h-9";
const quiet = "underline hover:text-foreground";

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: ReactNode }) {
  return <li className={`flex min-w-0 flex-col gap-3 rounded-lg border p-4 ${done ? "border-border" : "border-input"}`}>
    <h3 className="flex items-center gap-2 text-sm font-medium">{done
      ? <span className="grid size-6 shrink-0 place-items-center rounded-full bg-success-soft text-success"><Check className="size-3.5" aria-label="Done" /></span>
      : <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-xs">{n}</span>}{title}</h3>
    {children}
  </li>;
}

export function FirstSteps({ steps }: { steps: FirstRun }) {
  const { ai, money, agents } = steps;
  return <section aria-labelledby="first-steps" className={`${card} flex flex-col gap-4`}>
    <div><h2 id="first-steps" className="text-base font-medium">Get started</h2><p className="text-sm text-muted-foreground">Set up Moneo in a few steps. Each one works on its own.</p></div>
    <ol className={`grid gap-3 ${agents ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
      <Step n={1} done={ai !== "todo"} title={ai === "on" ? "AI is on" : ai === "skipped" ? "AI skipped" : "Turn on AI"}>
        {ai === "todo" ? <>
          <p className="text-sm text-muted-foreground">Sign in with ChatGPT or Claude, or paste an API key. Chat, calls and the agent team use it.</p>
          <div className="mt-auto flex flex-wrap items-center gap-2"><Link href="/settings#ai-access" className={primary}>Turn on AI</Link><SkipAiSetup /></div>
        </> : <p className="text-sm text-muted-foreground">{ai === "on" ? "Chat, calls and the agent team are ready." : <>Turn it on any time in <Link href="/settings#ai-access" className={quiet}>Settings</Link>.</>}</p>}
      </Step>
      <Step n={2} done={money} title={money ? "Money added" : "Add your money"}>
        {money ? <p className="text-sm text-muted-foreground">Your accounts are on <Link href="/money/accounts" className={quiet}>Accounts</Link>. Import more any time.</p> : <>
          <div className="space-y-1"><Link href="/import" className={primary}>Import a statement</Link><p className="text-xs text-muted-foreground">A CSV or PDF from your bank. The quick way.</p></div>
          <div className="space-y-1"><Link href="/settings#banks" className={secondary}>Connect a bank</Link><p className="text-xs text-muted-foreground">Needs a free Enable Banking account and takes about 10 minutes once.</p></div>
          <p className="mt-auto text-xs text-muted-foreground">or <Link href="/money/accounts" className={quiet}>add an account by hand</Link></p>
        </>}
      </Step>
      {agents && <Step n={3} done={agents.done} title={agents.done ? "Agent team has run" : "Run the agent team"}>
        {agents.done ? <p className="text-sm text-muted-foreground"><Link href="/ai/agents" className={quiet}>See what it found</Link>.</p> : <>
          <p className="text-sm text-muted-foreground">It sorts categories, finds recurring payments and suggests budgets from your transactions.</p>
          <div className="mt-auto">{ai === "on" ? <StartAgentRun className={`${primary} gap-2 disabled:opacity-50`} /> : <Link href="/settings#ai-access" className={secondary}>Turn on AI first</Link>}</div>
        </>}
      </Step>}
    </ol>
  </section>;
}
