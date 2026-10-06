import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TransactionsPage from "./page";
import { requireWorkspace } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("./actions", () => ({}));
vi.mock("../views/actions", () => ({ deleteTransactionView: vi.fn(), renameTransactionView: vi.fn(), saveTransactionView: vi.fn(), updateTransactionViewFilters: vi.fn() }));

it.each([
  { tag: "x".repeat(41) },
  { eventName: "x".repeat(121), categoryId: "22222222-2222-4222-8222-222222222222" },
])("renders actionable invalid saved scope without any finance queries: %j", async (filters) => {
  const viewId = "11111111-1111-4111-8111-111111111111";
  const from = vi.fn((table: string) => {
    if (!["accounts", "categories", "merchants", "transaction_views"].includes(table)) {
      throw new Error(`Forbidden finance query: ${table}`);
    }
    const result = { data: table === "transaction_views" ? [{ id: viewId, name: "Broken synthetic view", version: 1 }] : [], error: null };
    const chain = {
      select: () => chain, eq: () => chain, is: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: { id: viewId, name: "Broken synthetic view", filters }, error: null }),
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    };
    return chain;
  });
  vi.mocked(requireWorkspace).mockResolvedValue({
    supabase: { from }, workspace: { id: "synthetic-workspace", locale: "en-US" },
  } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  const html = renderToStaticMarkup(await TransactionsPage({ searchParams: Promise.resolve({ view: viewId, transaction: "33333333-3333-4333-8333-333333333333" }) }));
  expect(html).toContain('role="alert"');
  expect(html).toContain("Saved view has an invalid");
  expect(html).toContain("save a corrected view, then delete this broken view");
  expect(html).toContain('href="/money/transactions"');
  expect(html).toContain('Delete saved view Broken synthetic view');
  expect(html).not.toContain('Save view</button>');
  expect(html).not.toContain('Use current filters');
  expect(html).toContain("Broken synthetic view");
  expect(from.mock.calls.every(([table]) => ["accounts", "categories", "merchants", "transaction_views"].includes(table))).toBe(true);
});
