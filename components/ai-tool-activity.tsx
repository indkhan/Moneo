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
  return <details className="my-4 rounded-lg border border-border text-xs"><summary className="cursor-pointer rounded-lg bg-muted px-3 py-2 font-mono">Completed tools · {tools.length}</summary><ul className="space-y-2 p-3">{tools.map(name => <li key={name} className="flex gap-2"><span className="text-brand" aria-hidden="true">✓</span>{labels[name] ?? name}</li>)}</ul><p className="px-3 pb-3 text-[10px] text-muted-foreground">Activity for this response. Saved answers remain in conversation history.</p></details>;
}
