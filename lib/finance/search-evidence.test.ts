import { expect, it } from "vitest";
import { searchTransactions } from "./tools";
import type { requireWorkspace } from "@/lib/auth";
const parent = "00000000-0000-4000-8000-000000000001";
it("retains provisional parent classification, exact effective allocations and canonical source links", async () => {
  const source = { id: parent, posted_on: "2026-09-01", amount_minor: "-100", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: ["source_transfer"], version: 1 };
  const components = [{ id: "component", parent_transaction_id: parent, amount_minor: "-40", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: ["source_transfer"] }];
  const queries: { table: string; columns?: string }[] = [];
  const context = { workspace: { id: "owned" }, supabase: { from: (table: string) => {
    const captured: { table: string; columns?: string } = { table }; queries.push(captured);
    const query = { select: (columns: string) => { captured.columns = columns; return query; }, eq: () => query, ilike: () => query, in: () => query, order: () => query,
      limit: async () => ({ data: [source], error: null }), range: async () => ({ data: components, error: null }) };
    return query;
  } } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>;
  const result = await searchTransactions({ query: "transfer" }, context);
  expect(queries[0].columns).toContain("review_reasons");
  expect(result![0]).toMatchObject({ review_reasons: ["source_transfer"], classificationStatus: "unresolved", financialKind: null, confirmedSpending: false,
    amountBasis: "canonical_parent", effectiveRows: components, link: `/money/transactions?transaction=${parent}` });
  expect(result![0].allocationSemantics).toContain("effective");
});
