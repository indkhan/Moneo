import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { AccountsPanel, InvestmentsPanel, NetWorthPanel } from "@/components/finance/widgets";

export const Route = createFileRoute("/investments")({
  head: () => ({
    meta: [
      { title: "Investments · Lumen finance" },
      {
        name: "description",
        content: "Portfolio performance, holdings and net worth trend in one clean view.",
      },
      { property: "og:title", content: "Investments · Lumen finance" },
      { property: "og:description", content: "Portfolio performance, holdings and net worth trend." },
    ],
  }),
  component: () => (
    <AppShell title="Investments" subtitle="Portfolio €62,190.83 · +4.7% this month">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <NetWorthPanel />
          <InvestmentsPanel />
        </div>
        <AccountsPanel />
      </div>
    </AppShell>
  ),
});