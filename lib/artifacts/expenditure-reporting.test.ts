import { expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";
import { spendingForArtifact } from "./finance-sdk";
import { buildCalculatorSnapshot } from "./snapshot";
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));

const rows = [{ id: "parent", parent_transaction_id: "parent", account_id: "synthetic", posted_on: "2026-10-01", amount_minor: "-1000", currency_code: "USD", status: "posted", kind: "transfer", review_reasons: [], version: 1 }, { id: "fee", parent_transaction_id: "parent", account_id: "synthetic", posted_on: "2026-10-01", amount_minor: "-1", currency_code: "USD", status: "posted", kind: "ordinary", review_reasons: [], version: 1 }, { id: "a", parent_transaction_id: "split", account_id: "synthetic", posted_on: "2026-10-01", amount_minor: "-1", currency_code: "USD", status: "posted", kind: "ordinary", review_reasons: [], version: 0 }, { id: "b", parent_transaction_id: "split", account_id: "synthetic", posted_on: "2026-10-01", amount_minor: "-1", currency_code: "USD", status: "posted", kind: "ordinary", review_reasons: [], version: 0 }];
function fixture(hasRate = true) {
  const tables: string[] = [];
  const supabase = { from: (table: string) => {
    tables.push(table);
    const query = { select: () => query, eq: () => query, neq: () => query, gte: () => query, lte: () => query, order: () => query, single: async () => ({ data: { active_version_id: "v", permissions: ["spending", "cashflow"] }, error: null }), range: async () => ({ data: table === "fx_rates" ? hasRate ? [{ id: "rate", from_currency: "USD", to_currency: "EUR", rate_text: "0.5", rate_date: "2026-10-01", source: "synthetic" }] : [] : rows, error: null }) };
    return query;
  } };
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase, workspace: { id: "w", display_currency: "EUR", timezone: "UTC" }, settings: { ai_data_scopes: ["transactions"] } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  return tables;
}
it("uses canonical converted postings consistently for SDK totals, account groups and sandbox daily datasets", async () => {
  fixture();
  const result = await spendingForArtifact("a", "", "spending", "2026-10", "base");
  expect(result).toMatchObject({ summary: { spendingMinor: "2" }, byAccount: [{ id: "synthetic", spendingMinor: "2" }], reporting: { postings: [{ id: "fee", parentAmountMinor: "-1000" }, { id: "split", originalAmountMinor: "-2", reportingAmountMinor: "-1" }] }, sourceCoverage: { financialCompleteness: "unknown", exclusions: { currency: 0, transfer: 1 } } });
  const snapshot = (await buildCalculatorSnapshot("a", "spending_explorer", { month: "2026-10", reportingView: "base" })).snapshot;
  expect(snapshot).toMatchObject({ spendingMinor: "2", daily: expect.arrayContaining([ { date: "2026-10-01", spendingMinor: "2" } ]), conversionCoverage: { status: "complete" }, sourceCoverage: { financialCompleteness: "unknown" }, resultBasis: "accepted reviewed postings; statement completeness is not established" });
});
it("retains incomplete conversion provenance in unavailable sandbox evidence and respects disabled imports", async () => {
  const tables = fixture(false);
  const snapshot = (await buildCalculatorSnapshot("a", "spending_explorer", { month: "2026-10", reportingView: "base" })).snapshot;
  expect(snapshot).toMatchObject({ unavailable: expect.any(String), reporting: { totals: null, perCurrency: { USD: { spendingMinor: "3" } } }, conversionCoverage: { status: "incomplete" }, sourceCoverage: { financialCompleteness: "unknown" } });
  expect(tables).not.toContain("source_transactions");
  expect(tables).not.toContain("imports");
});
