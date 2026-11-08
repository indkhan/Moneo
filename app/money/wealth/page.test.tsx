import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/safe-form", () => ({ SafeForm: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./actions", () => ({ saveWealthItem: async () => {}, saveWealthItemSafely: async () => ({}), removeWealthItemSafely: async () => ({}), undoWealthEventSafely: async () => ({}) }));
vi.mock("next/link", () => ({ default: "a" }));
const item = (id: string, kind: string, name: string, amount_minor: string, as_of: string) => ({ id, kind, name, amount_minor, as_of, currency_code: "EUR", quantity_text: kind === "holding" ? "1" : null, unit_price_text: kind === "holding" ? "20.00" : null,
  cost_basis_minor: null, linked_account_id: null, payment_account_id: null, annual_rate_text: kind === "debt" ? "0" : null, monthly_payment_minor: null, next_payment_on: null,
  payment_assumption_id: null, payment_transaction_id: null, version: 1, removed_at: null });
const tables: Record<string, unknown[]> = {
  wealth_items: [item("fund", "holding", "Index fund", "2000", "2026-10-16"), item("loan", "debt", "Car loan", "-1500", "2026-05-01")],
  wealth_events: [{ id: "e1", item_id: "fund", before: null, after: item("fund", "holding", "Index fund", "1000", "2026-06-01"), created_at: "2026-06-01T00:00:00Z", undone_at: null }],
  balance_snapshots: [{ account_id: "acc", amount_minor: "5000", currency_code: "EUR", as_of: "2026-04-01T00:00:00Z", undone_at: null }],
  transactions: [{ id: "t1", account_id: "acc", amount_minor: "-1000", currency_code: "EUR", posted_on: "2026-10-10", posted_at: null, status: "posted", version: 1 }],
  accounts: [{ id: "acc", name: "Checking", type: "checking", currency_code: "EUR", archived_at: null }],
};
const query = (data: unknown[]) => { const q = { select: () => q, eq: () => q, is: () => q, in: () => q, not: () => q, order: () => q, limit: () => q, range: async () => ({ data, error: null }),
  maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
  then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve) }; return q; };
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w", locale: "en-US", timezone: "UTC", display_currency: "EUR" },
  supabase: { from: (table: string) => query(tables[table] ?? []) } }) }));

it("summarizes accounts, assets and debts and charts recorded net worth", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-16T12:00:00Z"), toFake: ["Date"] });
  const { default: WealthPage } = await import("./page");
  const html = renderToStaticMarkup(await WealthPage());
  vi.useRealTimers();
  expect(html).toContain("Net worth (EUR)");
  // The account rolls forward like on Accounts (50.00 - 10.00); the loan valued in May is older but still counts, as on Overview.
  expect(html).toContain("EUR 45.00");
  expect(html).toMatch(/Accounts<\/dt><dd[^>]*>EUR 40.00/);
  expect(html).toContain("<polyline");
  expect(html).toContain("2025-10-31");
  expect(html).toContain("Investments");
  expect(html).toContain("Debts");
  expect(html).not.toContain("How this was calculated");
  expect(html).toContain("Undo Index fund change"); expect(html).toContain("Remove Car loan (keep history)");
  // Debts are owed in plain amounts, and the older loan is named as not from today.
  expect(html).toContain("Amount you still owe (EUR)"); expect(html).toContain('value="15.00"');
  expect(html).toContain("1 valuation is not from today and uses its last known value: Car loan (2026-05-"); expect(html).toContain("-EUR 15.00");
  expect(html).toContain("Net worth by month"); expect(html).toContain(">Today<");
});

it("shows the Scalable portfolio in its own panel, with today's move and each position's gain", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-16T12:00:00Z"), toFake: ["Date"] });
  const etf = { ...item("etf", "holding", "Tech ETF", "3549", "2026-10-16"), quantity_text: "8", unit_price_text: "4.43625", cost_basis_minor: "7089" };
  tables.wealth_items = [...tables.wealth_items, etf, item("cash", "asset", "Scalable cash", "2313", "2026-10-16")];
  tables.wealth_events = [...tables.wealth_events, { id: "e2", item_id: "etf", before: null, after: { ...etf, amount_minor: "3600", as_of: "2026-10-15" }, created_at: "2026-10-15T08:00:00Z", undone_at: null }];
  tables.scalable_connections = [{ status: "active", last_synced_at: "2026-10-16T06:00:00Z", portfolio: { currency: "EUR", asOf: "2026-10-16", totalMinor: "5862", securitiesMinor: "3549", cryptoMinor: "0", cashMinor: "2313",
    performance: [{ timeframe: "INTRADAY", returnMinor: "136" }, { timeframe: "ONE_YEAR", returnMinor: "-3511" }], itemIds: ["etf", "cash"],
    activity: [{ id: "t", date: "2026-10-14", status: "SETTLED", type: "buy", description: "Tech ETF", shares: "3", amountMinor: "-2463", currencyCode: "EUR" }] } }];
  const { default: WealthPage } = await import("./page");
  const html = renderToStaticMarkup(await WealthPage());
  vi.useRealTimers();
  expect(html).toContain("Scalable Capital");
  expect(html).toContain("+EUR 1.36"); expect(html).toContain("today");
  expect(html).toContain("1 year"); expect(html).toContain("-EUR 35.11");
  // 35.49 now against 70.89 paid.
  expect(html).toContain("-EUR 35.40"); expect(html).toContain("-49.9%");
  expect(html).toContain("Recent activity"); expect(html).toContain("Cash to invest");
  // Synced positions are not listed again as editable items, and the explanation panel is gone.
  expect(html).not.toContain("Remove Tech ETF (keep history)");
  expect(html).not.toContain("How this is worked out");
});
