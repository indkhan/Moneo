import { expect, it } from "vitest";
import { searchTransactions } from "./tools";
import type { requireWorkspace } from "@/lib/auth";
const parent = "00000000-0000-4000-8000-000000000001";
it("retains provisional parent classification, exact effective allocations and canonical source links", async () => {
  const source = { id: parent, posted_on: "2026-09-01", amount_minor: "-100", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: ["source_transfer"], version: 1 };
  const components = [{ id: "component", parent_transaction_id: parent, amount_minor: "-40", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: ["source_transfer"] }];
  const queries: { table: string; columns?: string }[] = [];
  const context = { workspace: { id: "owned" }, supabase: { rpc: async () => ({ data: [], error: null }), from: (table: string) => {
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

it("finds a nickname through similar descriptions after the exact matches", async () => {
  const exact = { id: "exact", posted_on: "2026-11-01", description: "Venji pizza", amount_minor: "-900", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [], version: 1 };
  const similar = { id: "similar", posted_on: "2026-09-28", description: "Venjalin Ravindran", amount_minor: "-25000", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [], version: 1 };
  const rpcCalls: unknown[] = [];
  const context = { workspace: { id: "owned" }, supabase: {
    rpc: async (name: string, args: unknown) => { rpcCalls.push([name, args]); return { data: [{ id: "exact" }, { id: "similar" }], error: null }; },
    from: (table: string) => {
      let ids: string[] | undefined;
      const query = { select: () => query, eq: () => query, ilike: () => query, gte: () => query, lte: () => query, order: () => query,
        in: (column: string, values: string[]) => { if (column === "id") ids = values; return query; },
        limit: async () => ({ data: ids ? [exact, similar].filter(row => ids!.includes(row.id)) : [exact], error: null }),
        range: async () => ({ data: table === "effective_transactions" ? [] : [], error: null }) };
      return query;
    } } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>;
  const result = await searchTransactions({ query: "Venji", limit: 5 }, context);
  expect(rpcCalls).toEqual([["similar_transaction_ids", { p_workspace_id: "owned", p_query: "Venji", p_limit: 5 }]]);
  expect(result.map(row => [row.id, row.match])).toEqual([["exact", "text"], ["similar", "similar_name"]]);
});
