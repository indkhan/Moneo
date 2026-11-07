import Link from "next/link";
import { Check } from "lucide-react";

const step = "flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 font-medium hover:bg-muted";
const number = (n: number) => <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-xs">{n}</span>;

/** Home before any money is recorded: turn on AI, connect a bank (or import), then run the agent team. */
export function FirstSteps({ ai }: { ai: boolean }) {
  return <div className="space-y-3"><p className="text-sm text-muted-foreground">Three steps to get started:</p>
    <ol className="grid gap-2 text-sm sm:grid-cols-3">
      <li>{ai
        ? <p className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 text-muted-foreground"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-success-soft text-success"><Check className="size-3.5" aria-hidden="true" /></span>AI is on</p>
        : <Link href="/settings#ai-access" className={step}>{number(1)}Turn on AI</Link>}</li>
      <li className="space-y-1"><Link href="/settings#banks" className={step}>{number(2)}Connect your bank</Link>
        <p className="px-3 text-xs text-muted-foreground">or <Link href="/import" className="underline hover:text-foreground">import a statement</Link> or <Link href="/money/accounts" className="underline hover:text-foreground">add an account by hand</Link></p></li>
      <li className="space-y-1"><Link href="/ai/agents" className={step}>{number(3)}Run the agent team</Link>
        <p className="px-3 text-xs text-muted-foreground">It sorts categories, finds recurring payments and suggests budgets.</p></li>
    </ol></div>;
}
