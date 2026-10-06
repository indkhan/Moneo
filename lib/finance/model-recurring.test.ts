import { expect, it, vi } from "vitest";
import { evaluatePlanForWorkspace } from "./model";
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));

it.each([100000n, -100000n])("does not repeat a confirmed observed anchor (%s)", async amount => {
  const assumption = { id: "assumption", name: "Monthly", source: "recurring_confirmed", account_id: "cash", amount_minor: amount.toString(), currency_code: "EUR", cadence: "monthly", starts_on: "2026-10-06", ends_on: null, enabled: true };
  const tables: Record<string, unknown[]> = {
    financial_assumptions: [assumption],
    recurring_series: [{ id: "series", assumption_id: "assumption", status: "confirmed", evidence_invalidated: false, recurring_series_transactions: [{ transaction_id: "observed" }] }],
  };
  const db = { from: (table: string) => {
    const query = { select: () => query, eq: () => query, is: () => query, order: () => query,
      range: async () => ({ data: tables[table] ?? [], error: null }), maybeSingle: async () => ({ data: null, error: null }) };
    return query;
  } };
  const result = await evaluatePlanForWorkspace(db as never, { id: "workspace", display_currency: "EUR", timezone: "Europe/Berlin" }, 32, undefined, {
    wealth: Promise.resolve([]), balanceEvidence: Promise.resolve({
      accounts: [{ id: "cash", name: "Cash", type: "checking", currency_code: "EUR" }],
      snapshots: [{ account_id: "cash", amount_minor: "200000", currency_code: "EUR", as_of: "2026-10-06T08:00:00Z", provenance: "statement", boundary_kind: "after_transaction", source_transaction_id: "source" }],
      ledger: [{ id: "observed", account_id: "cash", amount_minor: amount.toString(), currency_code: "EUR", posted_on: "2026-10-06", posted_at: "2026-10-06T08:00:00Z", status: "posted", source_transaction_ids: ["source"] }],
      asOf: "2026-10-06T12:00:00Z",
    }),
  });
  expect(result.input.events.map(event => event.date)).toEqual(["2026-11-06"]);
  expect(result.forecast.status).toBe("available");
  if (result.forecast.status === "available") expect(result.forecast.days[0].expectedMinor).toBe(200000n);
});

