import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { CashFlowPanel, MonthCashFlow, RecentTransactions } from "./home-sections";

vi.mock("next/link", () => ({ default: "a" }));
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => search }));
const panel = async (params: Record<string, string> = {}) => { search = new URLSearchParams(params); return renderToStaticMarkup(await CashFlowPanel(props)); };
vi.mock("./home-trend-chart", () => ({ TrendChart: ({ labels, flow }: { labels: string[]; flow?: string }) => <div data-chart={labels.join(",")} data-flow={flow} /> }));
vi.mock("@/lib/finance/dashboard-spending", async original => {
  const actual = await original<typeof import("@/lib/finance/dashboard-spending")>();
  const row = { account_id: "a", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [] };
  const summary = actual.summarizeSpending([
    { ...row, id: "1", posted_on: "2026-10-02", amount_minor: "-4000", category_id: "food", merchant_id: null },
    { ...row, id: "2", posted_on: "2026-09-02", amount_minor: "-2000", category_id: "food", merchant_id: "shop" },
    { ...row, id: "3", posted_on: "2026-10-01", amount_minor: "250000", category_id: "salary", merchant_id: "employer" },
  ], [], "EUR", "2026-10-16");
  return { ...actual, loadHomeSpending: async () => ({ ...summary, categoryNames: new Map([["food", "Food"], ["salary", "Salary"]]), merchantNames: new Map([["employer", "Acme GmbH"]]) }) };
});
const props = { db: {} as SupabaseClient, workspaceId: "w", currency: "EUR", today: "2026-10-16", locale: "en" };

it("shows both sides by default and only the picked side's breakdown, linked to filtered transactions", async () => {
  const both = await panel();
  expect(both).toContain('data-chart="May,Jun,Jul,Aug,Sep,Oct"');
  expect(both).not.toContain("Top categories");
  expect(both).not.toContain("Where money came from");
  expect(both).toContain('href="?show=in&amp;flow=in#cash-flow"');

  const spending = await panel({ flow: "out" });
  // A picked breakdown never hides the other bars; only the Show buttons do.
  expect(spending).not.toContain('data-flow="out"');
  expect(spending).toContain("Top categories in October");
  expect(spending).toContain("/money/transactions?category=food&amp;from=2026-10-01&amp;to=2026-10-16&amp;direction=outflow");
  expect(spending).toContain("merchant=none");
  expect(spending).toContain('href="?flow=out#cash-flow"');
  const onlyOut = await panel({ show: "out", flow: "out" });
  expect(onlyOut).toContain('data-flow="out"');
  expect(onlyOut).toContain("Top categories in October");

  const september = await panel({ flow: "out", month: "2026-09" });
  expect(september).toContain("Top merchants in September");
  expect(september).toContain("merchant=shop&amp;from=2026-09-01&amp;to=2026-09-30");

  const income = await panel({ flow: "in" });
  expect(income).toContain("Where money came from in October");
  expect(income).toContain("Acme GmbH");
  expect(income).toContain("merchant=employer&amp;from=2026-10-01&amp;to=2026-10-16&amp;direction=income");
  expect(income).not.toContain("Top merchants");
});

it("totals this month's money in and out and what is left", async () => {
  search = new URLSearchParams();
  const html = renderToStaticMarkup(await MonthCashFlow(props));
  for (const text of ["October cash flow", "day 16 / 31", "+EUR 2500.00", "-EUR 40.00", "Left this month", "EUR 2460"]) expect(html).toContain(text);
  expect(html).toContain('href="?month=2026-10&amp;flow=in#cash-flow"');
});

it("lists recent ledger entries with account names, status and the total count", async () => {
  const rows = [{ id: "t1", posted_on: "2026-10-15", description: "Coffee", amount_minor: "-350", currency_code: "EUR", status: "pending", account_id: "a", review_reasons: [] }];
  const query = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: rows, count: 42, error: null }) };
  const html = renderToStaticMarkup(await RecentTransactions({ db: { from: () => query } as unknown as SupabaseClient, workspaceId: "w", locale: "en", names: new Map([["a", "Checking"]]) }));
  for (const text of ["All 42", "Coffee", "Checking · pending", "-EUR 3.50", "/money/transactions?transaction=t1"]) expect(html).toContain(text);
});
