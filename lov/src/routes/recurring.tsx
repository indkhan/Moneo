import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { RecurringPanel, InsightCard } from "@/components/finance/widgets";

export const Route = createFileRoute("/recurring")({
  head: () => ({
    meta: [
      { title: "Recurring · Lumen finance" },
      {
        name: "description",
        content: "Every subscription and standing payment, detected automatically with renewal dates.",
      },
      { property: "og:title", content: "Recurring · Lumen finance" },
      {
        property: "og:description",
        content: "Subscriptions and standing payments detected automatically.",
      },
    ],
  }),
  component: () => (
    <AppShell title="Recurring payments" subtitle="5 detected · €1,388 committed each month">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <RecurringPanel />
        <InsightCard />
      </div>
    </AppShell>
  ),
});