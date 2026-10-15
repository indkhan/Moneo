import { ChevronRight } from "lucide-react";

const labels: Record<string, string> = {
  transactions_search: "Search transactions", analytics_cashflow: "Calculate cashflow",
  accounts_list: "List accounts", accounts_getBalances: "Read dated balances",
  goals_list: "Read goals", forecast_evaluate: "Evaluate forecast", imports_status: "Read import status",
  reviews_investigate: "Investigate financial evidence", reviews_start: "Start deep review",
  artifacts_create: "Create saved tool", transactions_previewCategory: "Preview category change",
  transactions_setCategory: "Apply selected category change",
};

export function AiToolActivity({ tools }: { tools: string[] }) {
  if (!tools.length) return null;
  return <details className="group my-3 text-sm text-muted-foreground"><summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md py-1 hover:text-foreground [&::-webkit-details-marker]:hidden">Used {tools.length} {tools.length === 1 ? "tool" : "tools"}<ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" /></summary><ul className="mt-1 space-y-1 border-l-2 border-border pl-3">{tools.map(name => <li key={name}>{labels[name] ?? name}</li>)}</ul></details>;
}
