import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluatePlanForWorkspace } from "./model";
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));

it("keeps goal allocation identity and uses only FX rates available on each event date", async () => {
  const tables: Record<string, unknown[]> = {
    imports: [{ id: "i", status: "completed", total_rows: 1 }],
    source_transactions: [{ import_id: "i", status: "review", posted_on: "2026-10-09", currency_code: "USD", account_id: "checking" }],
    goal_allocations: [{ account_id: "savings", amount_minor: "10000" }],
    financial_assumptions: [{ id: "bill", name: "Bill", source: "user", account_id: "checking", amount_minor: "-50000", currency_code: "USD", cadence: "once", starts_on: "2026-10-08", ends_on: null, enabled: true }],
    fx_rates: [
      { from_currency: "USD", to_currency: "EUR", rate_text: "1", rate_date: "2026-10-07", source: "synthetic" },
      { from_currency: "USD", to_currency: "EUR", rate_text: "2", rate_date: "2026-10-08", source: "synthetic" },
      { from_currency: "USD", to_currency: "EUR", rate_text: "9", rate_date: "2026-10-09", source: "synthetic" },
    ],
  };
  const supabase = { from: (table: string) => {
    const query = { select: () => query, eq: () => query, is: () => query, order: () => query,
      range: async () => ({ data: tables[table] ?? [], error: null }),
      maybeSingle: async () => ({ data: table === "forecast_preferences" ? { currency_code: "EUR", safety_buffer_minor: "0", daily_spending_minor: "0", uncertainty_bps: 0, spending_account_id: null, spending_starts_on: null } : null, error: null }),
    }; return query;
  } } as unknown as SupabaseClient;
  const evidence = { balanceEvidence: Promise.resolve({ asOf: "2026-10-07T12:00:00Z",
    accounts: [{ id: "checking", name: "Checking", type: "checking", currency_code: "USD" }, { id: "savings", name: "Savings", type: "savings", currency_code: "EUR" }],
    snapshots: [ { account_id: "checking", amount_minor: "10000", currency_code: "USD", as_of: "2026-10-07T12:00:00Z", provenance: "manual" },
      { account_id: "savings", amount_minor: "9007199254740993", currency_code: "EUR", as_of: "2026-10-07T12:00:00Z", provenance: "manual" } ], ledger: [],
  }), wealth: Promise.resolve([]) };
  const result = await evaluatePlanForWorkspace(supabase, { id: "synthetic", display_currency: "EUR", timezone: "Europe/Berlin" }, 3, undefined, evidence);
  expect(result.sourceCoverage).toMatchObject({ unresolvedSourceRows: 1, scope: { from: "2026-10-07", to: "2026-10-10" }, totalsAreBounds: false });
  expect(result.input.events[0].expectedMinor).toBe(-100000n);
  expect(result.liquidity).toMatchObject({ currencyCode: "EUR", accounts: [
    { accountId: "checking", amountMinor: -90000n, protectedMinor: 0n, limitingDate: "2026-10-08" },
    { accountId: "savings", amountMinor: 9007199254730993n, protectedMinor: 10000n },
  ] });
  tables.fx_rates = [];
  expect((await evaluatePlanForWorkspace(supabase, { id: "synthetic", display_currency: "EUR", timezone: "Europe/Berlin" }, 3, undefined, evidence)).liquidity.status).toBe("unavailable");
});
