import { expect, it, vi } from "vitest";
import { evaluatePlanForWorkspace } from "./model";
import type { BalanceSnapshot, BalanceTransaction } from "./balances";
import type { OccurrenceSettlement } from "./recurring-occurrences";
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
const assumption = { id: "assumption", name: "Monthly", source: "recurring_confirmed", account_id: "cash", amount_minor: "100000", currency_code: "EUR", cadence: "monthly", starts_on: "2026-10-06", ends_on: null, enabled: true };
const posting = { id: "observed", account_id: "cash", amount_minor: "100000", currency_code: "EUR", posted_on: "2026-10-06", posted_at: "2026-10-06T08:00:00Z", status: "posted", source_transaction_ids: ["source"], kind: "ordinary", review_reasons: [] };
const snapshot = { account_id: "cash", amount_minor: "200000", currency_code: "EUR", as_of: "2026-10-06T08:00:00Z", provenance: "statement", boundary_kind: "after_transaction", source_transaction_id: "source" };
async function evaluateFixture(item = assumption, ledger: BalanceTransaction[] = [posting], opening: BalanceSnapshot = snapshot, settlements: OccurrenceSettlement[] = [], days = 32) {
  const tables: Record<string, unknown[]> = {
    financial_assumptions: [item], recurring_occurrence_settlements: settlements,
    recurring_series: [{ id: "series", assumption_id: "assumption", status: "confirmed", evidence_invalidated: false, recurring_series_transactions: [{ transaction_id: "observed" }] }],
  };
  const db = { from: (table: string) => {
    const query = { select: () => query, eq: () => query, is: () => query, order: () => query,
      range: async () => ({ data: tables[table] ?? [], error: null }), maybeSingle: async () => ({ data: null, error: null }) };
    return query;
  } };
  return evaluatePlanForWorkspace(db as never, { id: "workspace", display_currency: "EUR", timezone: "Europe/Berlin" }, days, undefined, {
    wealth: Promise.resolve([]), balanceEvidence: Promise.resolve({ accounts: [{ id: "cash", name: "Cash", type: "checking", currency_code: "EUR" }], snapshots: [opening], ledger, asOf: "2026-10-06T12:00:00Z" }),
  });
}
it.each([100000n, -100000n])("does not repeat a confirmed observed anchor (%s)", async amount => {
  const result = await evaluateFixture({ ...assumption, amount_minor: amount.toString() }, [{ ...posting, amount_minor: amount.toString() }]);
  expect(result.input.events.map(event => event.date)).toEqual(["2026-11-06"]);
  expect(result.forecast.status).toBe("available");
  if (result.forecast.status === "available") expect(result.forecast.days[0].expectedMinor).toBe(200000n);
});
it("reconciles a posting absent from the snapshot once before suppressing its anchor", async () => {
  const result = await evaluateFixture(assumption, [posting], { ...snapshot, amount_minor: "100000", as_of: "2026-10-06T07:00:00Z", source_transaction_id: "earlier" }, [], 1);
  expect(result.input.accounts[0].balanceMinor).toBe(200000n);
  expect(result.input.events).toEqual([]);
  expect(result.available).toMatchObject({ status: "available", amountMinor: 200000n });
});
it("preserves user schedules and unrelated identical postings", async () => {
  const user = await evaluateFixture({ ...assumption, source: "user" }, [posting], snapshot, [], 1);
  expect(user.input.events).toHaveLength(1);
  const unrelated = await evaluateFixture(assumption, [{ ...posting, id: "unrelated" }], snapshot, [], 1);
  expect(unrelated.input.events).toHaveLength(1);
});
const rent = { ...assumption, source: "user", amount_minor: "-10000" };
const partial = { ...posting, amount_minor: "-4000" };
const association: OccurrenceSettlement = { id: "link", assumption_id: "assumption", scheduled_on: "2026-10-06", transaction_id: "observed", completes_occurrence: false,
  receipt: { account_id: "cash", amount_minor: "-4000", currency_code: "EUR", kind: "ordinary", review_reasons: [] }, undone_at: null };
it.each(["pending", "posted"])("adds only a partial %s obligation remainder after opening cash", async status => {
  const result = await evaluateFixture(rent, [{ ...partial, status }], { ...snapshot, as_of: "2026-10-06T07:00:00Z", source_transaction_id: "earlier" }, [association], 1);
  expect(result.input.events).toMatchObject([{ expectedMinor: -6000n }]);
  expect(result.forecast.status).toBe("available");
  if (result.forecast.status === "available") expect(result.forecast.days[0].expectedMinor).toBe(190000n);
});
it("keeps a linked late future posting and removes the duplicate scheduled full obligation", async () => {
  const result = await evaluateFixture(rent, [{ ...partial, posted_on: "2026-10-08", posted_at: "2026-10-08T08:00:00Z" }], snapshot, [{ ...association, completes_occurrence: true }], 3);
  expect(result.input.events).toMatchObject([{ date: "2026-10-08", expectedMinor: -4000n }]);
  expect(result.input.accounts[0].balanceMinor).toBe(200000n);
});
it("restores an overdue explicitly undone obligation", async () => {
  const result = await evaluateFixture({ ...rent, starts_on: "2026-09-06" }, [partial], snapshot, [{ ...association, scheduled_on: "2026-09-06", undone_at: "2026-10-06T10:00:00Z" }], 1);
  expect(result.input.events).toMatchObject([{ date: "2026-10-06", expectedMinor: -10000n }, { date: "2026-10-06", expectedMinor: -10000n }]);
});
it("surfaces changed association evidence instead of claiming an exact forecast", async () => {
  const result = await evaluateFixture(rent, [{ ...partial, kind: "transfer" }], snapshot, [association], 1);
  expect(result.input.events).toMatchObject([{ expectedMinor: -10000n }]);
  expect(result.available.status).toBe("unavailable");
  expect(result.input.missingInputs).toContain("occurrence:Monthly:2026-10-06:link:evidence changed; undo or review the association");
});
it.each([100000n, -100000n])("retains observed generated anchor evidence after association undo (%s)", async amount => {
  const observed = { ...posting, amount_minor: amount.toString() };
  const undone: OccurrenceSettlement = { ...association, completes_occurrence: true, undone_at: "2026-10-06T10:00:00Z", receipt: { ...association.receipt, amount_minor: amount.toString() } };
  const result = await evaluateFixture({ ...assumption, amount_minor: amount.toString() }, [observed], snapshot, [undone], 1);
  expect(result.input.events).toEqual([]);
  expect(result.available).toMatchObject({ status: "available", amountMinor: 200000n });
});

it("keeps an inferred original calendar anchor when its latest observed payment shifts early", async () => {
  const item = {...assumption, starts_on: "2026-10-05", schedule_anchor_on: "2026-08-06"};
  const result = await evaluateFixture(item, [{...posting, posted_on: "2026-10-05", posted_at: "2026-10-05T08:00:00Z"}]);
  expect(result.input.events.map(event => event.date)).toEqual(["2026-11-06"]);
});

it("lets intentional user dates override a retained inferred calendar anchor", async () => {
  const item = {...assumption, source: "user", schedule_anchor_on: "2026-08-31"};
  const result = await evaluateFixture(item, [posting], snapshot, [], 32);
  expect(result.input.events.map(event => event.date)).toEqual(["2026-10-06", "2026-11-06"]);
});
