import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./actions", () => ({ saveWealthItem: async () => {}, removeWealthItem: async () => {}, undoWealthEvent: async () => {} }));
const item = (id: string, kind: string, name: string, amount_minor: string, as_of: string) => ({ id, kind, name, amount_minor, as_of, currency_code: "EUR", quantity_text: kind === "holding" ? "1" : null, unit_price_text: kind === "holding" ? "20.00" : null,
  cost_basis_minor: null, linked_account_id: null, payment_account_id: null, annual_rate_text: kind === "debt" ? "0" : null, monthly_payment_minor: null, next_payment_on: null,
  payment_assumption_id: null, payment_transaction_id: null, version: 1, removed_at: null });
const tables: Record<string, unknown[]> = {
  wealth_items: [item("fund", "holding", "Index fund", "2000", "2026-10-16"), item("loan", "debt", "Car loan", "-1500", "2026-05-01")],
  wealth_events: [{ id: "e1", item_id: "fund", before: null, after: item("fund", "holding", "Index fund", "1000", "2026-06-01"), created_at: "2026-06-01T00:00:00Z", undone_at: null }],
  balance_snapshots: [{ account_id: "acc", amount_minor: "5000", currency_code: "EUR", as_of: "2026-04-01T00:00:00Z", undone_at: null }],
  accounts: [{ id: "acc", name: "Checking", type: "checking", currency_code: "EUR", archived_at: null }],
};
const query = (data: unknown[]) => { const q = { select: () => q, eq: () => q, is: () => q, order: () => q, limit: () => q, range: async () => ({ data, error: null }),
  then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve) }; return q; };
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w", locale: "en-US", timezone: "UTC", display_currency: "EUR" },
  supabase: { from: (table: string) => query(tables[table] ?? []) } }) }));

it("summarizes accounts, assets and debts and charts recorded net worth", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-16T12:00:00Z"), toFake: ["Date"] });
  const { default: WealthPage } = await import("./page");
  const html = renderToStaticMarkup(await WealthPage());
  vi.useRealTimers();
  expect(html).toContain("Net worth (EUR)");
  expect(html).toContain("EUR 55.00"); // 50.00 account + 20.00 fund - 15.00 loan
  expect(html).toContain("<polyline");
  expect(html).toContain("2025-10-31");
  expect(html).toContain("Investments");
  expect(html).toContain("Debts");
  expect(html).toContain("1 valuation is dated before today");
  expect(html).toContain("Undo wealth change");
});
