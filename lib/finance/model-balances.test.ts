import { afterEach, expect, it, vi } from "vitest";
import { evaluatePlan } from "./model";

const fixture = vi.hoisted(() => ({ asOf: "2026-09-28T12:00:00Z", pending: false, includeAssumptions: false, debt: false, preferences: null as null | { currency_code: string; safety_buffer_minor: string; daily_spending_minor: string; uncertainty_bps: number; spending_account_id: string | null; spending_starts_on: string | null; version: number } }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "workspace", display_currency: "EUR", timezone: "Europe/Berlin" },
  supabase: { from: (table: string) => {
    const filters = new Map<string, unknown>();
    const data = table === "accounts" ? [{ id: "00000000-0000-4000-8000-000000000001", name: "Cash", type: "checking", currency_code: "EUR" }] :
      table === "balance_snapshots" ? [{ id: "balance", account_id: "00000000-0000-4000-8000-000000000001", amount_minor: "10000", currency_code: "EUR", as_of: fixture.asOf, provenance: "manual" }] :
        table === "transactions" && fixture.pending ? [{ id: "hold", account_id: "00000000-0000-4000-8000-000000000001", amount_minor: "-2000", currency_code: "EUR", posted_on: "2026-10-01", status: "pending" }] :
          table === "wealth_items" && fixture.debt ? [{ id: "loan", name: "Loan", kind: "debt", amount_minor: "-5000", currency_code: "EUR", as_of: "2026-10-01", payment_account_id: "00000000-0000-4000-8000-000000000001", annual_rate_text: "0", monthly_payment_minor: "2000", next_payment_on: "2026-10-01", payment_assumption_id: null, payment_transaction_id: fixture.pending ? "hold" : null, removed_at: null }] : [];
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters.set(key, value); return query; }, is: () => query, maybeSingle: async () => ({ data: fixture.preferences, error: null }), order: () => query, range: async () => ({ data, error: null }),
      then: (resolve: (result: { data: unknown[]; error: null }) => unknown) => {
        const assumptions = [true, false].map(confirmed => ({ account_id: "00000000-0000-4000-8000-000000000001", amount_minor: "-1000", currency_code: "EUR", cadence: "once", starts_on: "2026-10-02", ends_on: null, enabled: true, confirmed }));
        return Promise.resolve({ data: table === "financial_assumptions" && fixture.includeAssumptions ? assumptions.filter(item => filters.get("confirmed") === undefined || item.confirmed === filters.get("confirmed")) : data, error: null }).then(resolve);
      } };
    return query;
  } },
}) }));
afterEach(() => vi.useRealTimers());

it("uses confirmed recurring assumptions rather than unreviewed inferences", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  fixture.asOf = "2026-10-01T08:00:00Z"; fixture.includeAssumptions = true;
  try { expect((await evaluatePlan(30)).input.events).toHaveLength(1); }
  finally { fixture.includeAssumptions = false; fixture.asOf = "2026-09-28T12:00:00Z"; }
});

it("does not fund a forecast from a historical opening balance", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  const result = await evaluatePlan(30);
  expect(result.input.accounts[0].balanceMinor).toBeNull();
  expect(result.available.status).toBe("unavailable");
  expect(result.input.missingInputs).toContain("balance:00000000-0000-4000-8000-000000000001:stale");
});

it("deducts negative pending book-balance holds once", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  fixture.asOf = "2026-10-01T08:00:00Z";
  fixture.pending = true;
  try {
    const result = await evaluatePlan(30);
    expect(result.available).toMatchObject({ status: "available", amountMinor: 8000n });
  } finally { fixture.pending = false; fixture.asOf = "2026-09-28T12:00:00Z"; }
});

it("uses an exact current balance and Berlin calendar date", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T22:30:00Z"));
  fixture.asOf = "2026-09-30T22:15:00Z";
  const result = await evaluatePlan(30);
  expect(result.input.startDate).toBe("2026-10-01");
  expect(result.input.accounts[0].balanceMinor).toBe(10000n);
  expect(result.available).toMatchObject({ status: "available", amountMinor: 10000n });
  fixture.asOf = "2026-09-28T12:00:00Z";
});

it("funds debt repayments from liquid cash and consumes a linked pending hold once", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  fixture.asOf = "2026-10-01T08:00:00Z"; fixture.debt = true;
  try {
    const result = await evaluatePlan(30);
    expect(result.input.accounts).toHaveLength(1);
    expect(result.input.events).toMatchObject([{ accountId: "00000000-0000-4000-8000-000000000001", date: "2026-10-01", expectedMinor: -2000n }]);
    expect(result.available).toMatchObject({ status: "available", amountMinor: 8000n });
    fixture.pending = true;
    const held = await evaluatePlan(30);
    expect(held.input.events).toEqual([]);
    expect(held.available).toMatchObject({ status: "available", amountMinor: 8000n });
  } finally { fixture.debt = false; fixture.pending = false; fixture.asOf = "2026-09-28T12:00:00Z"; }
});

it("protects the buffer once and adds only the explicitly estimated variable spending", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  fixture.asOf = "2026-10-01T08:00:00Z";
  fixture.preferences = { currency_code: "EUR", safety_buffer_minor: "500", daily_spending_minor: "1000", uncertainty_bps: 1000, spending_account_id: "00000000-0000-4000-8000-000000000001", spending_starts_on: "2026-10-01", version: 2 };
  try {
    const result = await evaluatePlan(2);
    expect(result.forecast).toMatchObject({ status: "available", days: [{ expectedMinor: 9000n, conservativeMinor: 8900n }, { expectedMinor: 8000n, conservativeMinor: 7800n }] });
    expect(result.available).toMatchObject({ status: "available", amountMinor: 7300n, limitingDate: "2026-10-02" });
    expect(result.input.accounts.reduce((sum, account) => sum + (account.safetyBufferMinor ?? 0n), 0n)).toBe(500n);
    fixture.preferences.currency_code = "USD";
    expect((await evaluatePlan(2)).available.status).toBe("unavailable");
  } finally { fixture.preferences = null; fixture.asOf = "2026-09-28T12:00:00Z"; }
});
