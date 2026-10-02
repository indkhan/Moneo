import { expect, it, vi } from "vitest";
import { cashflow, searchTransactions } from "./tools";

const fixture = vi.hoisted(() => ({ tables: [] as string[] }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w", display_currency: "EUR" }, supabase: {
  from: (table: string) => {
    fixture.tables.push(table);
    const query = { select: () => query, eq: () => query, gte: () => query, lte: () => query, order: () => query, ilike: () => query,
      range: async () => ({ data: table === "effective_transactions" ? [
        { amount_minor: "-9007199254740000", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [] },
        { amount_minor: "-993", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [] },
      ] : [{ amount_minor: "-9007199254740993", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [] }], error: null }),
      limit: async () => ({ data: [{ id: "parent", amount_minor: "-9007199254740993" }], error: null }) };
    return query;
  },
} }) }));

it("uses effective allocations for exact spending while search retains one canonical parent", async () => {
  fixture.tables.length = 0;
  expect(await cashflow({ from: "2026-10-01", to: "2026-10-02", currencyCode: "EUR" })).toMatchObject({
    spendingMinor: "9007199254740993", evidence: { transactionCount: 2 },
  });
  expect(await searchTransactions({ query: "receipt" })).toEqual([{ id: "parent", amount_minor: "-9007199254740993" }]);
  expect(fixture.tables).toEqual(["effective_transactions", "transactions"]);
});
