import { afterEach, expect, it, vi } from "vitest";
import { evaluatePlan } from "./model";

const fixture = vi.hoisted(() => ({ asOf: "2026-09-28T12:00:00Z", pending: false, includeAssumptions: false }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "workspace", display_currency: "EUR" },
  supabase: { from: (table: string) => {
    const filters = new Map<string, unknown>();
    const data = table === "accounts" ? [{ id: "cash", name: "Cash", type: "checking", currency_code: "EUR" }] :
      table === "balance_snapshots" ? [{ id: "balance", account_id: "cash", amount_minor: "10000", currency_code: "EUR", as_of: fixture.asOf, provenance: "manual" }] :
        table === "transactions" && fixture.pending ? [{ id: "hold", account_id: "cash", amount_minor: "-2000", currency_code: "EUR", posted_on: "2026-10-01", status: "pending" }] : [];
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters.set(key, value); return query; }, order: () => query, range: async () => ({ data, error: null }),
      then: (resolve: (result: { data: unknown[]; error: null }) => unknown) => {
        const assumptions = [true, false].map(confirmed => ({ account_id: "cash", amount_minor: "-1000", currency_code: "EUR", cadence: "once", starts_on: "2026-10-02", ends_on: null, enabled: true, confirmed }));
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
  expect(result.input.missingInputs).toContain("balance:cash:stale");
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
