import { expect, it, vi } from "vitest";
import { cashflow } from "./tools";
import type { requireWorkspace } from "@/lib/auth";
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));

const account = "00000000-0000-4000-8000-000000000001";
const rows = [{ id: "eur", parent_transaction_id: "eur", account_id: account, posted_on: "2026-10-07", amount_minor: "-100", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [], version: 0 }, { id: "usd", parent_transaction_id: "usd", account_id: account, posted_on: "2026-10-07", amount_minor: "-101", currency_code: "USD", status: "posted", kind: "ordinary", review_reasons: [], version: 2 }];
function context(rates = [{ id: "dated-rate", from_currency: "USD", to_currency: "EUR", rate_text: "0.905", rate_date: "2026-10-07", source: "synthetic" }]) {
  const calls: unknown[][] = [];
  const supabase = { from: (table: string) => {
    let accountIds: string[] | undefined;
    const query = { select: () => query, eq: () => query, gte: () => query, lte: () => query, order: () => query, in: (key: string, values: string[]) => { calls.push([key, values]); accountIds = values; return query; }, range: async () => ({ data: table === "fx_rates" ? rates : rows.filter(row => !accountIds || accountIds.includes(row.account_id)), error: null }) };
    return query;
  } };
  return { value: { supabase, workspace: { id: "synthetic-workspace", display_currency: "EUR" } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>, calls };
}
const period = { from: "2026-10-01", to: "2026-10-07", currencyCode: "EUR" };
it("keeps unspecified currency accounting unchanged and enables explicit exact base reporting", async () => {
  const fixture = context();
  expect(await cashflow(period, fixture.value, false)).toMatchObject({ unavailable: "Some transactions require currency conversion" });
  const result = await cashflow({ ...period, view: "base" }, fixture.value, false);
  expect(result).toMatchObject({ spendingMinor: "191", conversionCoverage: { status: "complete" }, reporting: { postings: [{ id: "eur" }, { id: "usd", version: 2, rate: { id: "dated-rate" } }] }, sourceCoverage: { financialCompleteness: "unknown", exclusions: { currency: 0 } } });
  expect(result.sourceCoverage.scope).not.toHaveProperty("currencyCode");
});
it("returns explicit incomplete reporting and original subtotals when dated evidence is missing", async () => {
  expect(await cashflow({ ...period, view: "base" }, context([]).value, false)).toMatchObject({ unavailable: expect.any(String), reporting: { totals: null, availableTotals: { spendingMinor: "100" }, perCurrency: { USD: { spendingMinor: "101" } } }, conversionCoverage: { missingRateCount: 1 } });
  expect(await cashflow({ ...period, view: "original" }, context([]).value, false)).toMatchObject({ spendingMinor: "100", reporting: { view: "original", perCurrency: { USD: { spendingMinor: "101" } } } });
});
it("preserves account filter scope in both the database query and source coverage", async () => {
  const fixture = context();
  expect(await cashflow({ ...period, view: "base", accountIds: [account] }, fixture.value, false)).toMatchObject({ sourceCoverage: { scope: { accountIds: [account], accountScope: "selected_accounts" } } });
  expect(fixture.calls).toContainEqual(["account_id", [account]]);
});
