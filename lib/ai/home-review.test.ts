import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadHomeReview } from "@/lib/ai/home-review";

function fake(findings: unknown[], count: number) {
  return { from: (table: string) => {
    const query = { select: () => query, eq: () => query, is: () => query, neq: () => query, not: () => query, order: () => query, limit: () => query,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(table === "transactions" ? { count, error: null } : { data: findings, error: null }).then(resolve) };
    return query;
  } } as unknown as SupabaseClient;
}

it("shows a finding raised by several runs once, carrying every id so one dismissal closes all", async () => {
  const evidence = { transactions: [{ id: "t1" }], links: [] };
  const review = await loadHomeReview(fake([
    { id: "new", conflict_key: "duplicate:a:b", title: "Possible duplicate", detail: "Twice", evidence },
    { id: "old", conflict_key: "duplicate:a:b", title: "Possible duplicate", detail: "Twice", evidence },
    { id: "fee", conflict_key: "fees:EUR", title: "3 fees", detail: "", evidence: { links: [{ href: "/money/transactions?q=fee" }] } },
  ], 12), "w");
  expect(review).toEqual({ uncategorized: 12, findings: [
    { ids: ["new", "old"], title: "Possible duplicate", detail: "Twice", href: "/money/transactions?transaction=t1", transactions: [] },
    { ids: ["fee"], title: "3 fees", detail: "", href: "/money/transactions?q=fee", transactions: [] },
  ] });
});
