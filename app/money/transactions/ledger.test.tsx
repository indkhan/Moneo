import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TransactionsPage from "./page";
import { TransactionDrawer } from "./drawer";
import { requireWorkspace } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("./actions", () => Object.fromEntries(["bulkEditTransactions", "clearLink", "createManualTransaction", "markRefund", "quickEditTransaction", "splitTransaction", "undoCorrection", "undoTransactionSplits", "undoVerifiedLink", "verifiedLink"].map(name => [name, vi.fn()])));
vi.mock("../views/actions", () => ({ deleteTransactionView: vi.fn(), renameTransactionView: vi.fn(), saveTransactionView: vi.fn(), updateTransactionViewFilters: vi.fn() }));
vi.mock("./editing-history", () => ({ EditingHistory: () => null }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tx = (n: number, category: string | null, amount: string, posted_on = "2026-09-0" + n) => ({ id: id(n), version: 1, posted_on, description: `Row ${n}`, amount_minor: amount, currency_code: "EUR", status: "posted", kind: "ordinary",
  account_id: id(50), category_id: category, merchant_id: null, tags: [], event_name: null, review_reasons: [], note: "", transfer_id: null, refund_of_id: null });
const tables: Record<string, unknown> = {
  accounts: [{ id: id(50), name: "Checking", currency_code: "EUR", archived_at: null }],
  categories: [{ id: id(60), name: "Groceries" }, { id: id(61), name: "Dining" }],
  merchants: [], transaction_views: [],
  transactions: [tx(1, id(60), "-9007199254740993"), tx(2, id(61), "-500"), tx(3, id(60), "-7")],
  correction_events: [{ id: id(70), before: { category_id: id(60), note: "", version: 0 }, after: { category_id: id(61), note: "lunch", version: 1 }, undone: false, created_at: "2026-09-02T10:00:00Z" }],
};
const calls: unknown[][] = [];
function client() {
  return { from: (table: string) => {
    let single = false;
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "neq", "is", "order", "limit", "or", "ilike", "contains", "gte", "lte", "gt", "lt", "in"]) chain[method] = (...args: unknown[]) => { calls.push([table, method, ...args]); return chain; };
    chain.maybeSingle = () => { single = true; return chain; };
    chain.then = (resolve: (value: unknown) => unknown) => {
      const rows = (tables[table] ?? []) as unknown[];
      return Promise.resolve({ data: single ? (table === "transactions" ? rows[0] : null) : rows, error: null, count: rows.length }).then(resolve);
    };
    return chain;
  } };
}
vi.mocked(requireWorkspace).mockResolvedValue({ supabase: client(), workspace: { id: id(10), locale: "en-US", timezone: "UTC", display_currency: "EUR" } } as never);

it("renders a grouped dense ledger with exact subtotals, chips and a sticky header", async () => {
  const html = renderToStaticMarkup(await TransactionsPage({ searchParams: Promise.resolve({ group: "category", status: "posted", minAmount: "-1000" }) }));
  expect(html).toContain("sticky top-0");
  expect(html).toContain("Groceries");
  expect(html).toContain("2 transactions");
  expect(html).toContain("−EUR 90071992547410.00"); // -9007199254740993 + -7, exact
  expect(html).toContain("Remove filter Posted");
  expect(html).toContain("Remove filter At least -EUR 10.00");
  expect(html).toContain("3 transactions");
  expect(html).toContain("Select Row 1");
  expect(html).toContain('aria-label="Saved views"');
  expect(calls).toContainEqual(["transactions", "eq", "status", "posted"]);
  expect(calls).toContainEqual(["transactions", "gte", "amount_minor", "-1000"]);
});

it("drawer uses plain labels, exact money and readable correction history", async () => {
  const html = renderToStaticMarkup(await TransactionDrawer({ id: id(1), query: "", linkSearch: "", accountNames: { [id(50)]: "Checking" }, categories: tables.categories as never, merchants: [] }));
  expect(html).toContain("-EUR 90071992547409.93");
  expect(html).not.toContain("minor units");
  expect(html).toContain("Posted · Regular");
  expect(html).toContain("Category: Groceries → Dining");
  expect(html).toContain("Undo correction");
  expect(html).toContain("Save correction");
});
