import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import {
  AccountsPanel,
  BudgetsPanel,
  InsightCard,
  InvestmentsPanel,
  NetWorthPanel,
  RecurringPanel,
  SpendingPanel,
  TransactionsPanel,
} from "@/components/finance/widgets";
import { PinnedViews } from "@/components/finance/pinned-views";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard · Lumen finance" },
      {
        name: "description",
        content:
          "Your accounts, spending, budgets, investments and recurring payments in one calm AI-first dashboard.",
      },
      { property: "og:title", content: "Dashboard · Lumen finance" },
      {
        property: "og:description",
        content: "Accounts, spending, budgets and investments in one calm AI-first dashboard.",
      },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  return (
    <AppShell title="Good morning, Mara" subtitle="Saturday, 8 August · everything is up to date">
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <NetWorthPanel />
          <div className="grid gap-5 md:grid-cols-2">
            <SpendingPanel />
            <BudgetsPanel />
          </div>
          <TransactionsPanel />
        </div>
        <div className="space-y-5">
          <InsightCard />
          <AccountsPanel />
          <RecurringPanel />
          <InvestmentsPanel />
        </div>
      </div>

      <PinnedViews />
    </AppShell>
  );
}
