import { expect, it, vi } from "vitest";
import { cashflow, searchTransactions, listAccounts, listGoals } from "./tools";

const fixture = vi.hoisted(() => ({ tables: [] as string[] }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w", display_currency: "EUR" }, settings: { ai_data_scopes: [] }, supabase: {
  from: (table: string) => {
    fixture.tables.push(table);
    const query = { then: (resolve: (value: unknown) => unknown) => resolve({ data: [{ id: "synthetic", name: "Synthetic record" }], error: null }), select: () => query, eq: () => query, in: () => query, gte: () => query, lte: () => query, order: () => query, ilike: () => query,
      range: async () => ({ data: table === "effective_transactions" ? [
        { amount_minor: "-9007199254740000", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [] },
        { amount_minor: "-993", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [] },
        { amount_minor: "500", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: ["source_transfer"] },
      ] : table === "imports" ? [{ id: "i", status: "completed", total_rows: 1 }] : table === "source_transactions" ? [{ import_id: "i", status: "review", posted_on: "2026-10-01", currency_code: "EUR" }] : [], error: null }),
      limit: async () => ({ data: [{ id: "parent", amount_minor: "-9007199254740993" }], error: null }) };
    return query;
  },
} }) }));

it("keeps non-AI finance reads usable with no AI scopes and exact canonical/effective semantics", async () => {
  fixture.tables.length = 0;
  expect(await cashflow({ from: "2026-10-01", to: "2026-10-02", currencyCode: "EUR" })).toMatchObject({
    spendingMinor: "9007199254740993", evidence: { transactionCount: 3, includedTransactionCount: 2, partial: true,
      limitation: "Excluded classifications are unknown; these partial totals are not upper or lower bounds." },
    calculationEvidence: { rows: [expect.objectContaining({ amount_minor: "-9007199254740000" }), expect.objectContaining({ amount_minor: "-993" }), expect.objectContaining({ review_reasons: ["source_transfer"] })] },
  });
  expect(await searchTransactions({ query: "receipt" })).toMatchObject([{ id: "parent", amount_minor: "-9007199254740993", amountBasis: "canonical_parent", effectiveRows: [] }]);
  expect(fixture.tables).toEqual(["effective_transactions", "imports", "source_transactions", "transactions", "effective_transactions"]);
});

it("attaches unresolved source coverage without changing included exact money or reading revoked imports", async () => {
  expect(await cashflow({ from: "2026-10-01", to: "2026-10-02", currencyCode: "EUR" })).toMatchObject({
    spendingMinor: "9007199254740993", sourceCoverage: { unresolvedSourceRows: 1, includedRows: 2, totalsAreBounds: false },
  });
  fixture.tables.length = 0;
  const result = await cashflow({ from: "2026-10-01", to: "2026-10-02", currencyCode: "EUR" }, undefined, false);
  expect(result).toMatchObject({ sourceCoverage: { observedSourceRows: null, financialCompleteness: "unknown" } });
  expect(fixture.tables).toEqual(["effective_transactions"]);
});

it("keeps ordinary account and goal lists usable after AI permission revocation", async () => {
  expect(await listAccounts()).toEqual([{ id: "synthetic", name: "Synthetic record" }]);
  expect(await listGoals()).toEqual([{ id: "synthetic", name: "Synthetic record" }]);
});
