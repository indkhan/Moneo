import { Check, ChevronRight, LoaderCircle, X } from "lucide-react";

const labels: Record<string, string> = {
  transactions_search: "Search transactions", analytics_cashflow: "Calculate cashflow",
  accounts_list: "List accounts", accounts_getBalances: "Read dated balances",
  goals_list: "Read goals", forecast_evaluate: "Evaluate forecast", imports_status: "Read import status",
  reviews_investigate: "Investigate financial evidence", reviews_start: "Start deep review",
  transactions_previewCategory: "Preview category change",
  transactions_setCategory: "Apply selected category change",
  finance_investigate: "Investigate transactions", finance_entities: "Resolve accounts, categories and merchants",
  finance_detail: "Read transaction detail", finance_scenario: "Compare a what-if scenario", plan_investigation: "Plan the investigation",
};

export type ToolStep = { id?: string; name: string; state: "running" | "done" | "failed"; input?: unknown; output?: string };

/** One-line gist of a tool input: its first few short scalar values, e.g. "spending · Netto · 2026-10-01". */
export function toolSummary(input: unknown): string {
  const values: string[] = [];
  const walk = (value: unknown) => {
    if (values.length >= 4 || value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") { const text = String(value); if (text && text.length <= 40) values.push(text); }
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(input);
  return values.join(" · ");
}

const block = "mt-1 max-h-60 max-w-full overflow-auto whitespace-pre rounded-md bg-muted p-2 font-mono text-[11px] text-foreground";

function Step({ step }: { step: ToolStep }) {
  const icon = step.state === "running" ? <LoaderCircle className="size-3.5 animate-spin" aria-label="Running" /> : step.state === "failed" ? <X className="size-3.5 text-danger" aria-label="Failed" /> : <Check className="size-3.5" aria-label="Done" />;
  const summary = toolSummary(step.input);
  const line = <span className="flex min-w-0 items-center gap-1.5 [&>svg]:shrink-0">{icon}<span className="truncate">{labels[step.name] ?? step.name}{summary && <span className="opacity-75"> · {summary}</span>}</span></span>;
  if (step.input === undefined && step.output === undefined) return <li className="min-w-0">{line}</li>;
  return <li className="min-w-0"><details className="group/step min-w-0">
    <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
      <span className="min-w-0 flex-1">{line}</span><ChevronRight className="size-3.5 shrink-0 transition-transform group-open/step:rotate-90" aria-hidden="true" />
    </summary>
    {step.input !== undefined && <><p className="mt-1 text-xs font-medium">Input</p><pre className={block}>{JSON.stringify(step.input, null, 2)}</pre></>}
    {step.output !== undefined && <><p className="mt-1 text-xs font-medium">Output</p><pre className={block}>{step.output}</pre></>}
  </details></li>;
}

/** Collapsible tool activity; live steps stay open while any is still running. Each call expands to its input and output. */
export function AiToolActivity({ tools }: { tools: (string | ToolStep)[] }) {
  if (!tools.length) return null;
  const steps = tools.map(tool => typeof tool === "string" ? { name: tool, state: "done" as const } : tool);
  const running = steps.some(step => step.state === "running");
  const count = `${steps.length} ${steps.length === 1 ? "tool" : "tools"}`;
  return <details open={running || undefined} className="group my-2 min-w-0 text-sm text-muted-foreground">
    <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
      {running && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}{running ? `Using ${count}…` : `Used ${count}`}
      <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
    </summary>
    <ul className="mt-1 min-w-0 space-y-1 border-l-2 border-border pl-3">{steps.map((step, index) => <Step key={step.id ?? `${step.name}-${index}`} step={step} />)}</ul>
  </details>;
}
