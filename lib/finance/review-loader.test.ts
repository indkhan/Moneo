import { expect, it, vi } from "vitest";
import { loadFinancialReviewEvidence } from "./review-loader";
import { settingsSchema } from "@/lib/settings";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./balances", async original => ({ ...await original<typeof import("./balances")>(), loadBalanceEvidence: async () => ({ accounts: [], snapshots: [], ledger: [], asOf: "2026-10-02T12:00:00Z" }) }));
vi.mock("./model", () => ({ evaluatePlanForWorkspace: vi.fn(async () => ({ available: { status: "unavailable", missingInputs: ["balance"] }, forecast: [], input: { events: [] } })) }));

it("omits all planning reads when its scope is disabled and gathers exact comparison sources", async () => {
  const reads: string[] = [];
  const from = (table: string) => {
    reads.push(table);
    const query = { select: () => query, eq: () => query, gte: () => query, lte: () => query, order: () => query, in: () => query,
      range: async () => ({ data: table === "effective_transactions" ? [{ id: "t", parent_transaction_id: "t", account_id: "a", amount_minor: "-9007199254740993", currency_code: "EUR", posted_on: "2026-10-01", status: "posted", kind: "ordinary", category_id: null, merchant_id: null, review_reasons: [] }] : [], error: null }) };
    return query;
  };
  const evidence = await loadFinancialReviewEvidence({ from } as unknown as SupabaseClient, { id: "workspace", display_currency: "EUR", timezone: "Europe/Berlin" }, settingsSchema.parse({ ai_data_scopes: ["accounts", "transactions"] }));
  expect(reads).not.toContain("imports"); expect(reads).not.toContain("source_transactions"); expect(reads).not.toContain("spending_plans");
  expect(evidence.cashflow.EUR.spendingMinor).toBe("9007199254740993");
  expect(evidence).toMatchObject({ sourceCoverage: { unresolvedSourceRows: null, scope: { from: "2026-07-05", to: "2026-10-02" } } });
  expect(evidence.planning).toEqual({ unavailable: "AI access to planning is disabled in Settings" });
  expect(evidence.investigation.records.items[0].link).toBe("/money/transactions?transaction=t");
  expect(evidence.investigation.groups[0].currentMinor).toBe("9007199254740993");
});
it("loads older rollover evidence without extending the current cashflow summary", async () => {
  const lowerBounds: string[] = [];
  const tables: Record<string, unknown[]> = {
    spending_plans: [{ id: "b", category_id: "c", currency_code: "EUR", limit_minor: "1000", enabled: true, rollover: true, rollover_from: "2026-01-01" }],
    spending_plan_limits: [{ plan_id: "b", effective_month: "2026-01-01", limit_minor: "1000", enabled: true, version: 1 }],
    effective_transactions: [{ id: "old", amount_minor: "-200", currency_code: "EUR", posted_on: "2026-01-01", status: "posted", kind: "ordinary", category_id: "c", merchant_id: null, review_reasons: [] }],
  };
  const from = (table: string) => {
    const query = { select: () => query, eq: () => query, is: () => query, gte: (_key: string, value: string) => { lowerBounds.push(value); return query; }, lte: () => query, order: () => query,
      range: async () => ({ data: tables[table] ?? [], error: null }) }; return query;
  };
  const evidence = await loadFinancialReviewEvidence({ from } as unknown as SupabaseClient, { id: "workspace", display_currency: "EUR", timezone: "Europe/Berlin" }, settingsSchema.parse({}));
  expect(lowerBounds).toEqual(["2026-01-01", "2026-04-06"]);
  expect(evidence.cashflow).toEqual({});
  expect((evidence.planning as { budgets: unknown[] }).budgets[0]).toMatchObject({ carriedMinor: "8800", remainingMinor: "9800", spentMinor: "0" });
});
