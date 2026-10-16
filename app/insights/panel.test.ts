import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadInsightEvidence } from "./panel";

it("loads insight evidence in parallel batches without losing refund categories or older recurring baselines", async () => {
  const originals = Array.from({ length: 150 }, (_, index) => ({ id: `original-${index}`, category_id: `category-${index}`, posted_on: "2025-06-01" }));
  const tables: Record<string, Record<string, unknown>[]> = {
    spending_plans: [{ id: "plan", category_id: "c", currency_code: "EUR", limit_minor: "100", enabled: true, rollover: true, rollover_from: "2026-01-01" }],
    recurring_series: [{ id: "series", label: "Rent", evidence_invalidated: false, evidence_baseline: [{ id: "old-1" }, { id: "recent" }], invalidated_assumption_version: null }],
    effective_transactions: originals.map((original, index) => ({ id: `refund-${index}`, refund_of_id: original.id, posted_on: "2026-10-01" })),
    transactions: [{ id: "recent", posted_on: "2026-10-01" }, { id: "old-1", posted_on: "2025-01-01" }, ...originals],
  };
  const db = { from: (table: string) => {
    const filters: { gte?: string; ids?: string[] } = {};
    const rows = () => (tables[table] ?? []).filter(row => (!filters.gte || String(row.posted_on) >= filters.gte) && (!filters.ids || filters.ids.includes(String(row.id))));
    const query = { select: () => query, eq: () => query, order: () => query, lte: () => query,
      gte: (_column: string, value: string) => { filters.gte = value; return query; },
      in: (_column: string, ids: string[]) => { filters.ids = ids; return query; },
      range: async (from: number, to: number) => ({ data: rows().slice(from, to + 1), error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve) };
    return query;
  } } as unknown as SupabaseClient;
  const evidence = await loadInsightEvidence(db, "w", "EUR", "2026-10-15");
  expect(evidence.first).toBe("2026-01-01");
  expect(evidence.canonical.map(row => row.id)).toEqual(["recent"]);
  expect(evidence.recurringEvidence.get("old-1")).toMatchObject({ posted_on: "2025-01-01" });
  expect(evidence.transactions.map(row => row.refund_category_id)).toEqual(originals.map(original => original.category_id));
});
