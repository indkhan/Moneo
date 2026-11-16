import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadHomeReview } from "@/lib/ai/home-review";

type Row = Record<string, unknown>;

function fake(tables: Record<string, Row[] | Row | null>) {
  return { from: (table: string) => {
    const tests: ((row: Row) => boolean)[] = [];
    let counted = false;
    const query = {
      select: (_columns: string, options?: { count?: string }) => { counted = !!options?.count; return query; },
      eq: (column: string, value: unknown) => { tests.push(row => row[column] === value); return query; },
      neq: (column: string, value: unknown) => { tests.push(row => row[column] !== value); return query; },
      is: (column: string, value: unknown) => { tests.push(row => row[column] === value); return query; },
      gt: (column: string, value: string) => { tests.push(row => Date.parse(String(row[column])) > Date.parse(value)); return query; },
      not: () => query, order: () => query, limit: () => query,
      maybeSingle: () => ({ data: tables[table] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => {
        const rows = ((tables[table] as Row[] | undefined) ?? []).filter(row => tests.every(test => test(row)));
        return Promise.resolve(counted ? { count: rows.length, error: null } : { data: rows, error: null }).then(resolve);
      },
    };
    return query;
  } } as unknown as SupabaseClient;
}

const transaction = (id: string, created_at: string): Row => ({ id, workspace_id: "w", status: "posted", category_id: null, kind: "spend", created_at });
const findings = [
  { id: "new", workspace_id: "w", kind: "finding", status: "proposed", run_id: "r", conflict_key: "duplicate:a:b", title: "Possible duplicate", detail: "Twice", evidence: { transactions: [{ id: "t1" }], links: [] } },
  { id: "old", workspace_id: "w", kind: "finding", status: "proposed", run_id: "r", conflict_key: "duplicate:a:b", title: "Possible duplicate", detail: "Twice", evidence: { transactions: [{ id: "t1" }], links: [] } },
  { id: "fee", workspace_id: "w", kind: "finding", status: "proposed", run_id: "r", conflict_key: "fees:EUR", title: "3 fees", detail: "", evidence: { links: [{ href: "/money/transactions?q=fee" }] } },
];
const earlier = Array.from({ length: 12 }, (_, index) => transaction(`t${index}`, "2026-11-10T10:00:00.000Z"));

it("shows a finding raised by several runs once, carrying every id so one dismissal closes all", async () => {
  const review = await loadHomeReview(fake({ transactions: earlier, agent_proposals: findings }), "w");
  expect(review).toEqual({ uncategorized: 12, findings: [
    { ids: ["new", "old"], title: "Possible duplicate", detail: "Twice", href: "/money/transactions?transaction=t1", transactions: [] },
    { ids: ["fee"], title: "3 fees", detail: "", href: "/money/transactions?q=fee", transactions: [] },
  ] });
});

it("hides the uncategorized card after Skip all until a row arrives after it", async () => {
  const skipped = { uncategorized_skipped_at: "2026-11-16T09:00:00.000Z" };
  expect((await loadHomeReview(fake({ transactions: earlier, workspace_settings: skipped }), "w")).uncategorized).toBe(0);
  const arrived = [...earlier, transaction("new", "2026-11-16T10:00:00.000Z")];
  expect((await loadHomeReview(fake({ transactions: arrived, workspace_settings: skipped }), "w")).uncategorized).toBe(13);
});
