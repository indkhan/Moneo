import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { netWorth } from "@/app/money/wealth/net-worth";
import { buildReviewEvidence } from "./review";
import { resolveBalances } from "./balances";
import { convertedNetWorth, loadNetWorthEvidence, netWorthModel, readNetWorth } from "./net-worth-source";

const WS = "w", TODAY = "2026-11-08";
const workspace = { id: WS, timezone: "UTC", display_currency: "EUR", locale: "en-GB" };
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;

function from(name: string) {
  const filters: ((row: Row) => boolean)[] = [];
  const rows = () => (tables[name] ?? []).filter(row => filters.every(test => test(row)));
  const query: Record<string, unknown> = {
    select: () => query, order: () => query, gte: () => query, limit: () => query, range: (start: number, end: number) => ({ then: (done: (value: unknown) => unknown) => Promise.resolve({ data: rows().slice(start, end + 1), error: null }).then(done) }),
    eq: (column: string, value: unknown) => { filters.push(row => row[column] === undefined || row[column] === value); return query; },
    is: (column: string, value: unknown) => { filters.push(row => (row[column] ?? null) === value); return query; },
    not: (column: string, _op: string, value: unknown) => { filters.push(row => (row[column] ?? null) !== value); return query; },
    in: () => query, maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (done: (value: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(done),
  };
  return query;
}
const db = { from } as never;
const snapshot = (account_id: string, amount_minor: string, as_of: string, over: Row = {}) => ({ id: `${account_id}:${as_of}`, account_id, amount_minor, currency_code: "EUR", as_of, provenance: "bank:CLBD", boundary_kind: "date_only", created_at: as_of, ...over });
const posting = (id: string, account_id: string, amount_minor: string, posted_on: string, over: Row = {}) => ({ id, account_id, amount_minor, currency_code: "EUR", posted_on, status: "posted", kind: "ordinary", description: id, version: 1, transaction_sources: [], ...over });
const item = (id: string, name: string, kind: string, amount_minor: string, as_of: string, over: Row = {}) => ({ id, name, kind, amount_minor, as_of, currency_code: "EUR", linked_account_id: null, removed_at: null, version: 1, quantity_text: null, unit_price_text: null, cost_basis_minor: null, payment_account_id: null, annual_rate_text: null, monthly_payment_minor: null, next_payment_on: null, payment_assumption_id: null, payment_transaction_id: null, ...over });
const event = (row: ReturnType<typeof item>, created_at: string) => ({ id: `e:${row.id}:${created_at}`, item_id: row.id, before: null, after: row, created_at, undone_at: null });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  tables = { accounts: [{ id: "bank", name: "Bank", type: "checking", currency_code: "EUR", archived_at: null, version: 1 }], balance_snapshots: [snapshot("bank", "100000", "2026-10-01T00:00:00Z")], transactions: [], wealth_items: [], wealth_events: [] };
});
afterEach(() => vi.useRealTimers());

const load = async () => netWorthModel(await loadNetWorthEvidence(db, workspace));
const headline = async () => convertedNetWorth(await load(), [], "EUR").totalMinor;

describe("one source", () => {
  it("gives Home, Wealth and chat the same total on the same data, ending the graph on it", async () => {
    tables.transactions = [posting("rent", "bank", "-30000", "2026-11-01"), posting("out", "bank", "-20000", "2026-11-02", { kind: "transfer" })];
    const fund = item("fund", "Fund", "asset", "50000", "2026-10-01"), owed = item("loan", "Car loan", "debt", "-10000", "2026-10-01", { annual_rate_text: "0", monthly_payment_minor: "0" });
    tables.wealth_items = [fund, owed]; tables.wealth_events = [event(fund, "2026-10-01T00:00:00Z"), event(owed, "2026-10-01T00:00:00Z")];
    const model = await load();
    const home = convertedNetWorth(model, [], "EUR").totalMinor;       // Home's headline
    const wealth = netWorth(model.now).get("EUR");                     // Wealth's total
    const chat = await readNetWorth({ supabase: db, workspace }, {});  // Chat, the voice call and artifacts
    const graph = netWorth(model.points([`2026-11-07`, TODAY]).at(-1)!).get("EUR");
    expect(home).toBe(90000n);
    expect(wealth).toBe(home);
    expect(graph).toBe(home);
    expect(chat).toMatchObject({ amountMinor: "90000", amountFormatted: expect.stringContaining("900") });
  });

  it("reads a past date the same way the graph does, and says when it can't", async () => {
    tables.transactions = [posting("rent", "bank", "-30000", "2026-11-01")];
    const model = await load();
    const past = await readNetWorth({ supabase: db, workspace }, { date: "2026-10-31" });
    expect(past).toMatchObject({ known: true, amountMinor: netWorth(model.points(["2026-10-31"])[0]).get("EUR")!.toString() });
    expect(await readNetWorth({ supabase: db, workspace }, { date: "2020-01-01" })).toMatchObject({ known: false });
    await expect(readNetWorth({ supabase: db, workspace }, { date: "2030-01-01" })).rejects.toThrow("future");
    expect(await readNetWorth({ supabase: db, workspace }, { days: 3 })).toMatchObject({ trend: [{ date: "2026-11-06" }, { date: "2026-11-07" }, { date: TODAY, amountMinor: "70000" }] });
  });

  it("names what it left out and how fresh each input is", async () => {
    tables.accounts.push({ id: "empty", name: "No balance", type: "checking", currency_code: "EUR", archived_at: null, version: 1 });
    const old = item("car", "Car", "asset", "500", "2026-11-01");
    tables.wealth_items = [old]; tables.wealth_events = [event(old, "2026-11-01T00:00:00Z")];
    const answer = await readNetWorth({ supabase: db, workspace }, {}) as { leftOut: string[]; freshness: { valuesNotFromToday: { name: string }[] } };
    expect(answer.leftOut.join(" ")).toContain("No balance");
    expect(answer.freshness.valuesNotFromToday).toEqual([expect.objectContaining({ name: "Car" })]);
  });

  it("leaves an archived account out of today and every reader, and keeps its past days", async () => {
    tables.accounts.push({ id: "old", name: "Old", type: "checking", currency_code: "EUR", archived_at: "2026-11-05T10:00:00Z", version: 2 });
    tables.balance_snapshots.push(snapshot("old", "5000", "2026-10-01T00:00:00Z"));
    const model = await load();
    expect(netWorth(model.now).get("EUR")).toBe(100000n);
    expect(netWorth(model.points(["2026-11-04"])[0]).get("EUR")).toBe(105000n);
    expect(netWorth(model.points(["2026-11-05"])[0]).get("EUR")).toBe(100000n);
  });

  it("lets every balance reader agree when one statement row was imported twice", async () => {
    const copies = [snapshot("bank", "100000", "2026-10-01T00:00:00Z", { id: "a", provenance: "import:a:row:1", source_transaction_id: "s1", created_at: "2026-10-02T00:00:00Z" }), snapshot("bank", "100000", "2026-10-01T00:00:00Z", { id: "b", provenance: "import:b:row:9", source_transaction_id: "s2", created_at: "2026-10-03T00:00:00Z" })];
    tables.balance_snapshots = copies;
    const accounts = tables.accounts as never[];
    const strict = resolveBalances(accounts, copies as never[], [], `${TODAY}T12:00:00Z`, "UTC")[0].balance;
    const review = buildReviewEvidence(accounts, copies as never[], [], TODAY, TODAY, { asOf: `${TODAY}T12:00:00Z`, ledger: [], timeZone: "UTC" });
    expect(strict).toMatchObject({ amount_minor: "100000", status: "stale", conflicts: [] });
    expect(review.netWorth).toEqual({ EUR: "100000" });
    expect(await headline()).toBe(100000n);
    expect(netWorth((await load()).points(["2026-10-15"])[0]).get("EUR")).toBe(100000n);
  });
});

describe("own money between accounts, on every screen", () => {
  const leg = (id: string, account: string, amount: string, on: string, other: string | null, over: Row = {}) => posting(id, account, amount, on, { kind: "transfer", transfer_id: other, ...over });
  it("corrects past days without touching today's total, and the Scalable seam counts it once", async () => {
    // First real Scalable value on 7 Nov, with calculated days before it. 600.00 went in on the 1st, and the bank paid on the 2nd.
    const cash = item("cash", "Scalable cash", "asset", "60000", TODAY);
    tables.wealth_items = [cash]; tables.wealth_events = [event({ ...cash, as_of: "2026-11-07" }, "2026-11-07T10:00:00Z"), event(cash, `${TODAY}T10:00:00Z`)];
    tables.scalable_connections = [{ portfolio: { itemIds: ["cash"] }, transfers_backfilled_at: "2026-11-07T10:00:00Z" }];
    tables.scalable_value_history = ["2026-10-30", "2026-10-31"].map(on_date => ({ on_date, currency_code: "EUR", total_minor: "0" })).concat(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map(on_date => ({ on_date, currency_code: "EUR", total_minor: "60000" })));
    tables.scalable_transfers = [{ provider_id: "D", type: "DEPOSIT", amount_minor: "60000", currency_code: "EUR", on_date: "2026-11-01", occurred_at: "2026-11-01T00:00:00Z", status: "SETTLED", is_cancellation: false, returns_provider_id: null, description: "Note on it" }];
    tables.own_account_identifiers = [{ id: "i", iban: "DE00BROKER000000000000", label: "Scalable Capital", account_id: null }];
    tables.transactions = [leg("pay", "bank", "-60000", "2026-11-02", null, { transaction_sources: [{ source_transactions: { original_row: { counterparty_iban: "DE00BROKER000000000000" } } }] })];
    tables.balance_snapshots = [snapshot("bank", "100000", "2026-10-01T00:00:00Z")];
    const model = await load();
    const totals = model.points(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-06", "2026-11-07", TODAY]).map(point => netWorth(point).get("EUR"));
    expect(totals).toEqual([100000n, 100000n, 100000n, 100000n, 100000n, 100000n]);
    expect(model.now.transit.size).toBe(0);
    expect(model.unresolved).toEqual([]);
    expect(model.windows).toMatchObject([{ kind: "matched", from: "2026-11-01", to: "2026-11-02", amountMinor: -60000n }]);
  });

  it("leaves one side showing as it is, marked unresolved, until the other lands", async () => {
    const cash = item("cash", "Scalable cash", "asset", "60000", "2026-11-07");
    tables.wealth_items = [cash]; tables.wealth_events = [event(cash, "2026-11-07T10:00:00Z")];
    tables.scalable_connections = [{ portfolio: { itemIds: ["cash"] }, transfers_backfilled_at: "2026-11-07T10:00:00Z" }];
    tables.scalable_transfers = [{ provider_id: "D", type: "DEPOSIT", amount_minor: "60000", currency_code: "EUR", on_date: "2026-11-07", occurred_at: "2026-11-07T00:00:00Z", status: "SETTLED", is_cancellation: false, returns_provider_id: null, description: null }];
    const model = await load();
    expect(netWorth(model.now).get("EUR")).toBe(160000n);
    expect(model.unresolved).toMatchObject([{ key: "broker:D", reason: "missing" }]);
  });
});

describe("this month, split", () => {
  it("shows a new bank as newly added, in the total but not in the change", async () => {
    tables.accounts.push({ id: "new", name: "New bank", type: "checking", currency_code: "EUR", archived_at: null, version: 1 });
    tables.balance_snapshots.push(snapshot("new", "250000", "2026-11-05T00:00:00Z"));
    tables.transactions = [posting("rent", "bank", "-30000", "2026-11-01")];
    const split = (await load()).monthSplit("EUR")!;
    expect(await headline()).toBe(320000n);
    expect(split).toMatchObject({ baseMinor: 100000n, totalChangeMinor: 220000n, newlyAddedMinor: 250000n, changeMinor: -30000n, moneyMinor: -30000n, investmentsMinor: 0n });
  });

  it("shows a hand-added item as newly added, and a later revaluation as a real move", async () => {
    const first = item("car", "Car", "asset", "800000", "2026-11-03"), later = { ...first, amount_minor: "750000", as_of: "2026-11-06" };
    tables.wealth_items = [later]; tables.wealth_events = [event(first, "2026-11-03T10:00:00Z"), event(later, "2026-11-06T10:00:00Z")];
    expect((await load()).monthSplit("EUR")).toMatchObject({ newlyAddedMinor: 800000n, investmentsMinor: -50000n, moneyMinor: 0n, changeMinor: -50000n, totalChangeMinor: 750000n });
  });

  it("treats a market move as investments, and moving your own money as neither", async () => {
    const before = item("fund", "Fund", "holding", "100000", "2026-10-01", { quantity_text: "1", unit_price_text: "1000" }), now = { ...before, amount_minor: "165000", as_of: TODAY };
    tables.wealth_items = [now]; tables.wealth_events = [event(before, "2026-10-01T10:00:00Z"), event(now, `${TODAY}T10:00:00Z`)];
    tables.scalable_connections = [{ portfolio: { itemIds: ["fund"] }, transfers_backfilled_at: null }];
    tables.scalable_value_history = [{ on_date: "2026-09-30", currency_code: "EUR", total_minor: "1" }];
    // 60.00 into the broker, paid from the bank: the fund rose 650.00 of which 60.00 is that deposit.
    tables.scalable_transfers = [{ provider_id: "D", type: "DEPOSIT", amount_minor: "6000", currency_code: "EUR", on_date: "2026-11-02", occurred_at: "2026-11-02T00:00:00Z", status: "SETTLED", is_cancellation: false, returns_provider_id: null, description: null }];
    tables.transactions = [posting("pay", "bank", "-6000", "2026-11-02", { kind: "transfer" })];
    const split = (await load()).monthSplit("EUR")!;
    expect(split).toMatchObject({ investmentsMinor: 59000n, moneyMinor: 0n, newlyAddedMinor: 0n, changeMinor: 59000n });
  });

  it("keeps a loan and its bank payment out of newly added: they net out in money in and out", async () => {
    const loan = item("iou", "Lent to Sam", "asset", "20000", "2026-11-03");
    tables.wealth_items = [loan]; tables.wealth_events = [event(loan, "2026-11-03T10:00:00Z")];
    tables.transactions = [posting("lend", "bank", "-20000", "2026-11-03")];
    expect((await load()).monthSplit("EUR")).toMatchObject({ newlyAddedMinor: 0n, moneyMinor: 0n, investmentsMinor: 0n, changeMinor: 0n });
  });

  it("has nothing to compare with before last month's end is on record", async () => {
    tables.balance_snapshots = [snapshot("bank", "100000", "2026-11-05T00:00:00Z")];
    expect((await load()).monthSplit("EUR")).toBeNull();
  });
});
