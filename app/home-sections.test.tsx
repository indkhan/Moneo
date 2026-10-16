import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { MonthSpendingKpi, RecentTransactions, SpendingPanel } from "./home-sections";

vi.mock("next/link", () => ({ default: "a" }));
vi.mock("./home-trend-chart", () => ({ TrendChart: ({ labels }: { labels: string[] }) => <div data-chart={labels.join(",")} /> }));
vi.mock("@/lib/dashboard-spending", async original => {
  const actual = await original<typeof import("@/lib/dashboard-spending")>();
  const row = { account_id: "a", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [] };
  const summary = actual.summarizeSpending([
    { ...row, id: "1", posted_on: "2026-10-02", amount_minor: "-4000", category_id: "food", merchant_id: null },
    { ...row, id: "2", posted_on: "2026-09-02", amount_minor: "-2000", category_id: "food", merchant_id: "shop" },
  ], [], "EUR", "2026-10-16");
  return { ...actual, loadHomeSpending: async () => ({ ...summary, categoryNames: new Map([["food", "Food"]]), merchantNames: new Map() }) };
});
const props = { db: {} as SupabaseClient, workspaceId: "w", currency: "EUR", today: "2026-10-16", locale: "en" };

it("links top categories and merchants to filtered transactions and compares with the same days last month", async () => {
  const html = renderToStaticMarkup(await SpendingPanel(props));
  expect(html).toContain('data-chart="May,Jun,Jul,Aug,Sep,Oct"');
  expect(html).toContain("Food");
  expect(html).toContain("/money/transactions?category=food&amp;from=2026-10-01&amp;to=2026-10-16&amp;direction=outflow");
  expect(html).toContain("Unknown merchant");
  expect(html).toContain("merchant=none");
  const kpi = renderToStaticMarkup(await MonthSpendingKpi(props));
  expect(kpi).toContain("EUR 40.00"); expect(kpi).toContain("vs EUR 20.00 by this day last month"); expect(kpi).toContain("up 100%");
});

it("lists recent ledger entries with account names, status and the total count", async () => {
  const rows = [{ id: "t1", posted_on: "2026-10-15", description: "Coffee", amount_minor: "-350", currency_code: "EUR", status: "pending", account_id: "a", review_reasons: [] }];
  const query = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: rows, count: 42, error: null }) };
  const html = renderToStaticMarkup(await RecentTransactions({ db: { from: () => query } as unknown as SupabaseClient, workspaceId: "w", locale: "en", names: new Map([["a", "Checking"]]) }));
  for (const text of ["All 42", "Coffee", "Checking · pending", "-EUR 3.50", "/money/transactions?transaction=t1"]) expect(html).toContain(text);
});
