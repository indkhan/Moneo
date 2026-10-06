import { expect, it, vi } from "vitest";
import { cashflow, searchTransactions, listAccounts, listGoals } from "./tools";

const fixture = vi.hoisted(() => ({ tables: [] as string[] }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w", display_currency: "EUR" }, settings: { ai_data_scopes: [] }, supabase: {
  from: (table: string) => {
    fixture.tables.push(table);
    const query = { then: (resolve: (value: unknown) => unknown) => resolve({ data: [{ id: "synthetic", name: "Synthetic record" }], error: null }), select: () => query, eq: () => query, gte: () => query, lte: () => query, order: () => query, ilike: () => query,
      range: async () => ({ data: table === "effective_transactions" ? [
        { amount_minor: "-9007199254740000", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [] },
        { amount_minor: "-993", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [] },
        { amount_minor: "500", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: ["source_transfer"] },
      ] : [{ amount_minor: "-9007199254740993", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [] }], error: null }),
      limit: async () => ({ data: [{ id: "parent", amount_minor: "-9007199254740993" }], error: null }) };
    return query;
  },
} }) }));

it("keeps non-AI finance reads usable with no AI scopes and exact canonical/effective semantics", async () => {
  fixture.tables.length = 0;
  expect(await cashflow({ from: "2026-10-01", to: "2026-10-02", currencyCode: "EUR" })).toMatchObject({
    spendingMinor: "9007199254740993", evidence: { transactionCount: 3, includedTransactionCount: 2, partial: true,
      limitation: "Excluded classifications are unknown; these partial totals are not upper or lower bounds." },
  });
  expect(await searchTransactions({ query: "receipt" })).toEqual([{ id: "parent", amount_minor: "-9007199254740993" }]);
  expect(fixture.tables).toEqual(["effective_transactions", "transactions"]);
});

it("keeps ordinary account and goal lists usable after AI permission revocation", async () => {
  expect(await listAccounts()).toEqual([{ id: "synthetic", name: "Synthetic record" }]);
  expect(await listGoals()).toEqual([{ id: "synthetic", name: "Synthetic record" }]);
});
