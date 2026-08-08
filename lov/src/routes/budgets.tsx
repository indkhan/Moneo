import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { BudgetsPanel, InsightCard, SpendingPanel } from "@/components/finance/widgets";

export const Route = createFileRoute("/budgets")({
  head: () => ({
    meta: [
      { title: "Budgets · Lumen finance" },
      {
        name: "description",
        content: "Track monthly budgets by category with calm, AI-adjusted limits.",
      },
      { property: "og:title", content: "Budgets · Lumen finance" },
      { property: "og:description", content: "Monthly budgets by category with AI-adjusted limits." },
    ],
  }),
  component: () => (
    <AppShell title="Budgets" subtitle="August · €1,172 of €1,550 used">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <BudgetsPanel />
        <div className="space-y-5">
          <InsightCard />
          <SpendingPanel />
        </div>
      </div>
    </AppShell>
  ),
});