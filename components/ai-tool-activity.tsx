import { Check, ChevronRight, LoaderCircle, X } from "lucide-react";

const labels: Record<string, string> = {
  transactions_search: "Search transactions", analytics_cashflow: "Calculate cashflow",
  accounts_list: "List accounts", accounts_getBalances: "Read dated balances",
  goals_list: "Read goals", forecast_evaluate: "Evaluate forecast", imports_status: "Read import status",
  reviews_investigate: "Investigate financial evidence", reviews_start: "Start deep review",
  artifacts_create: "Create saved tool", transactions_previewCategory: "Preview category change",
  transactions_setCategory: "Apply selected category change",
  finance_investigate: "Investigate transactions", finance_entities: "Resolve accounts, categories and merchants",
  finance_detail: "Read transaction detail", finance_scenario: "Compare a what-if scenario", plan_investigation: "Plan the investigation",
};

export type ToolStep = { id?: string; name: string; state: "running" | "done" | "failed" };

/** Collapsible tool activity; live steps stay open while any is still running. */
export function AiToolActivity({ tools }: { tools: (string | ToolStep)[] }) {
  if (!tools.length) return null;
  const steps = tools.map(tool => typeof tool === "string" ? { name: tool, state: "done" as const } : tool);
  const running = steps.some(step => step.state === "running");
  const count = `${steps.length} ${steps.length === 1 ? "tool" : "tools"}`;
  return <details open={running || undefined} className="group my-2 text-sm text-muted-foreground">
    <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
      {running && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}{running ? `Using ${count}…` : `Used ${count}`}
      <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
    </summary>
    <ul className="mt-1 space-y-1 border-l-2 border-border pl-3">{steps.map((step, index) => <li key={step.id ?? `${step.name}-${index}`} className="flex items-center gap-1.5">
      {step.state === "running" ? <LoaderCircle className="size-3.5 animate-spin" aria-label="Running" /> : step.state === "failed" ? <X className="size-3.5 text-red-600 dark:text-red-400" aria-label="Failed" /> : <Check className="size-3.5" aria-label="Done" />}
      {labels[step.name] ?? step.name}</li>)}</ul>
  </details>;
}
