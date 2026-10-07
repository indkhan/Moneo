import { expect, it, vi } from "vitest";
import { loadInvestigationEntities, runInvestigation, evaluateInvestigationScenario, investigationDetailSchema } from "./investigation-reader";

const id = "11111111-1111-4111-8111-111111111111";
function context() {
  const calls: [string, string, unknown][] = [];
  const db = { from(table: string) {
    let offset = 0;
    const query = {
      select: () => query, eq: (column: string, value: unknown) => { calls.push([table, column, value]); return query; },
      gte: () => query, lte: () => query, order: () => query,
      range: (from: number) => { offset = from; return query; },
      then(resolve: (value: unknown) => unknown) {
        const data = table === "accounts" ? [{ id, name: "Checking" }] : table === "effective_transactions" && !offset
          ? [{ id, parent_transaction_id: id, account_id: id, category_id: null, merchant_id: null, posted_on: "2026-09-01", amount_minor: "-100", currency_code: "EUR", status: "posted", kind: "ordinary", tags: [], event_name: null, review_reasons: [], version: 1, description: "Synthetic" }] : [];
        return Promise.resolve(resolve({ data, error: null }));
      },
    };
    return query;
  } };
  return { calls, context: { supabase: db, workspace: { id: "owned" } } as unknown as Parameters<typeof runInvestigation>[1] };
}
const query = { version: 1, period: { from: "2026-09-01", to: "2026-09-30" }, accounts: { include: [{ name: "Checking" }] } };
it("scopes every read to the owned workspace and resolves names before executing", async () => {
  const { calls, context: ctx } = context();
  const result = await runInvestigation(query, ctx);
  expect(result.groups[0].currentMinor).toBe("100");
  expect(result.interpretedFilters.accounts?.include).toEqual([{ id }]);
  expect(calls.length).toBeGreaterThan(4);
  expect(calls.every(([, key, value]) => key === "workspace_id" && value === "owned")).toBe(true);
  expect((await loadInvestigationEntities(ctx)).accounts).toEqual([{ id, name: "Checking" }]);
});
it("evaluates bounded hypothetical overrides without mutating canonical records", async () => {
  const { context: ctx } = context();
  const result = await evaluateInvestigationScenario({ query, overrides: [{ id, amountMinor: "-300" }] }, ctx);
  expect(result.baseline.groups[0].currentMinor).toBe("100");
  expect(result.hypothetical.groups[0].currentMinor).toBe("300");
  expect(result.canonicalMutations).toBe(false);
  await expect(evaluateInvestigationScenario({ query, overrides: [{ id: "22222222-2222-4222-8222-222222222222", amountMinor: "-3" }] }, ctx)).rejects.toThrow("owned");
  await expect(evaluateInvestigationScenario({ query, overrides: Array.from({ length: 101 }, () => ({ id, amountMinor: "0" })) }, ctx)).rejects.toThrow();
  vi.restoreAllMocks();
});
it("validates owned detail identifiers and complete pagination input", () => {
  expect(investigationDetailSchema.safeParse({ kind: "transaction", id }).success).toBe(true);
  expect(investigationDetailSchema.safeParse({ kind: "recurring", id, offset: 100, size: 100 }).success).toBe(true);
  expect(investigationDetailSchema.safeParse({ kind: "transaction", id: "invented" }).success).toBe(false);
  expect(investigationDetailSchema.safeParse({ kind: "recurring", id, size: 101 }).success).toBe(false);
});
