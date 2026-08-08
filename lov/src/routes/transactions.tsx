import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { TransactionsPanel, SpendingPanel } from "@/components/finance/widgets";

export const Route = createFileRoute("/transactions")({
  head: () => ({
    meta: [
      { title: "Transactions · Lumen finance" },
      {
        name: "description",
        content: "Every transaction across your accounts, auto-categorised and searchable.",
      },
      { property: "og:title", content: "Transactions · Lumen finance" },
      {
        property: "og:description",
        content: "Every transaction across your accounts, auto-categorised.",
      },
    ],
  }),
  component: () => (
    <AppShell title="Transactions" subtitle="412 this month across 4 accounts">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <TransactionsPanel limit={8} />
        <SpendingPanel />
      </div>
    </AppShell>
  ),
});