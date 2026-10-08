import { expect, it, vi } from "vitest";
import { evaluatePlanForWorkspace } from "./model";
import type { BalanceSnapshot, BalanceTransaction } from "./balances";
import type { OccurrenceSettlement } from "./recurring-occurrences";
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
const assumption = { id: "assumption", name: "Monthly", source: "recurring_confirmed", recurring_evidence_eligible: false, account_id: "cash", amount_minor: "100000", currency_code: "EUR", cadence: "monthly", starts_on: "2026-10-06", ends_on: null, enabled: true };
const posting = { id: "observed", account_id: "cash", amount_minor: "100000", currency_code: "EUR", posted_on: "2026-10-06", posted_at: "2026-10-06T08:00:00Z", status: "posted", source_transaction_ids: ["source"], kind: "ordinary", review_reasons: [] };
const snapshot = { account_id: "cash", amount_minor: "200000", currency_code: "EUR", as_of: "2026-10-06T08:00:00Z", provenance: "statement", boundary_kind: "after_transaction", source_transaction_id: "source" };
async function evaluateFixture(item = assumption, ledger: BalanceTransaction[] = [posting], opening: BalanceSnapshot = snapshot, settlements: OccurrenceSettlement[] = [], days = 32, asOf = "2026-10-06T12:00:00Z", validSeries = true) {
  const tables: Record<string, unknown[]> = {
    financial_assumptions: [item], recurring_occurrence_settlements: settlements,
    recurring_series: validSeries ? [{ id: "series", assumption_id: "assumption", status: "confirmed", evidence_invalidated: false, recurring_series_transactions: [{ transaction_id: "observed" }] }] : [],
  };
  const db = { from: (table: string) => {
    const query = { select: () => query, eq: () => query, is: () => query, order: () => query,
      range: async () => ({ data: tables[table] ?? [], error: null }), maybeSingle: async () => ({ data: null, error: null }) };
    return query;
  } };
  return evaluatePlanForWorkspace(db as never, { id: "workspace", display_currency: "EUR", timezone: "Europe/Berlin" }, days, undefined, {
    wealth: Promise.resolve([]), balanceEvidence: Promise.resolve({ accounts: [{ id: "cash", name: "Cash", type: "checking", currency_code: "EUR" }], snapshots: [opening], ledger, asOf }),
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

it("uses the replacement anchor persisted for an intentional user date edit", async () => {
  const item = {...assumption, source: "user", schedule_anchor_on: "2026-10-06"};
  const result = await evaluateFixture(item, [posting], snapshot, [], 32);
  expect(result.input.events.map(event => event.date)).toEqual(["2026-10-06", "2026-11-06"]);
});

it("retains Mar30 fulfillment of the Mar31 slot after persisted user-source disable/re-enable", async () => {
  const item={...assumption,amount_minor:"-9007199254740993",starts_on:"2026-03-31",schedule_anchor_on:"2026-01-31"};
  const ledger=[{...posting,id:"jan",posted_on:"2026-01-31",posted_at:"2026-01-31T08:00:00Z",amount_minor:item.amount_minor},
    {...posting,id:"feb",posted_on:"2026-02-28",posted_at:"2026-02-28T08:00:00Z",amount_minor:item.amount_minor},
    {...posting,posted_on:"2026-03-30",posted_at:"2026-03-30T08:00:00Z",amount_minor:item.amount_minor}];
  const opening={...snapshot,as_of:"2026-03-30T08:00:00Z",source_transaction_id:"source"};
  const before=await evaluateFixture(item,ledger,opening,[],3,"2026-03-30T12:00:00Z");
  expect(before.input.events).toEqual([]);
  const disabled=await evaluateFixture({...item,source:"user",enabled:false,recurring_evidence_eligible:true},ledger,opening,[],3,"2026-03-30T12:00:00Z");
  expect(disabled.input.events).toEqual([]);
  const after=await evaluateFixture({...item,source:"user",recurring_evidence_eligible:true},ledger,opening,[],3,"2026-03-30T12:00:00Z");
  expect(after.input.events).toEqual([]);
  expect(after.input.accounts).toEqual(before.input.accounts);
  expect(after.forecast).toEqual(before.forecast);
});
it.each(["amount","date","cadence","invalidated evidence"])("keeps %s override intent or source invalidation independent of toggle fulfillment", async fault => {
  const item={...assumption,source:"user",amount_minor:"-10000",starts_on:"2026-03-31",schedule_anchor_on:"2026-01-31",recurring_evidence_eligible:false};
  if(fault==="amount") item.amount_minor="-12345";
  if(fault==="date") {item.starts_on="2026-03-30";item.schedule_anchor_on="2026-03-30";}
  if(fault==="cadence") {item.cadence="quarterly";item.starts_on="2026-03-31";item.schedule_anchor_on="2026-03-31";}
  if(fault==="invalidated evidence") item.recurring_evidence_eligible=true;
  const observed={...posting,posted_on:"2026-03-30",posted_at:"2026-03-30T08:00:00Z",amount_minor:"-10000"};
  const result=await evaluateFixture(item,[observed],{...snapshot,as_of:observed.posted_at},[],3,"2026-03-30T12:00:00Z",fault!=="invalidated evidence");
  expect(result.input.events).toHaveLength(1);
  expect(result.input.events[0].expectedMinor).toBe(BigInt(item.amount_minor));
});
it.each(["pending", "transfer", "review", "after as-of"])("does not fulfill a toggled schedule with %s source evidence", async fault => {
  const item = {...assumption, source: "user", amount_minor: "-10000", starts_on: "2026-03-31", schedule_anchor_on: "2026-01-31", recurring_evidence_eligible: true};
  const observed = {...posting, amount_minor: "-10000", posted_on: "2026-03-30", posted_at: "2026-03-30T08:00:00Z", review_reasons: [] as string[]};
  if (fault === "pending") observed.status = "pending";
  if (fault === "transfer") observed.kind = "transfer";
  if (fault === "review") observed.review_reasons = ["needs review"];
  if (fault === "after as-of") observed.posted_at = "2026-03-30T13:00:00Z";
  const result = await evaluateFixture(item, [observed], {...snapshot, as_of: "2026-03-30T08:00:00Z"}, [], 3, "2026-03-30T12:00:00Z");
  expect(result.input.events.filter(event => event.date === "2026-03-31")).toMatchObject([{expectedMinor: -10000n}]);
});
