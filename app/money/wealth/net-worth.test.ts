import { describe, expect, it } from "vitest";
import { resolveBalances } from "@/lib/finance/balances";
import { archiveDates, currentNetWorth, dayRange, firstSyncedOn, monthEnds, netWorth, netWorthSeries, scalableKnownIds, valuationHistory } from "./net-worth";

it("lists month ends then today", () => {
  expect(monthEnds("2026-03-15", 3)).toEqual(["2025-12-31", "2026-01-31", "2026-02-28", "2026-03-15"]);
});

it("lists every day in an inclusive range", () => {
  expect(dayRange("2026-02-27", "2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
});

it("carries forward the latest recorded values per date without mixing currencies", () => {
  const valuation = (item_id: string, kind: string, amount_minor: string, as_of: string, created_at = `${as_of}T00:00:00Z`, extra: object = {}) =>
    ({ item_id, kind, amount_minor, as_of, created_at, currency_code: "EUR", linked_account_id: null, ...extra });
  const series = netWorthSeries({
    dates: ["2026-01-31", "2026-02-28", "2026-03-31"], timeZone: "UTC", accountIds: new Set(["a", "usd"]),
    snapshots: [
      { account_id: "a", amount_minor: "1000", currency_code: "EUR", as_of: "2026-01-10T00:00:00Z" },
      { account_id: "a", amount_minor: "5000", currency_code: "EUR", as_of: "2026-02-10T00:00:00Z", undone_at: "2026-02-11T00:00:00Z" },
      { account_id: "a", amount_minor: "1500", currency_code: "EUR", as_of: "2026-03-01T00:00:00Z" },
      { account_id: "usd", amount_minor: "700", currency_code: "USD", as_of: "2026-01-01T00:00:00Z" },
      { account_id: "archived", amount_minor: "999", currency_code: "EUR", as_of: "2026-01-01T00:00:00Z" },
    ],
    valuations: [
      valuation("fund", "holding", "2000", "2026-02-01"), valuation("fund", "holding", "2500", "2026-02-01", "2026-02-05T00:00:00Z"),
      valuation("loan", "debt", "-800", "2026-01-15"), valuation("car", "asset", "300", "2026-01-01"),
      valuation("linked", "asset", "100", "2026-01-01", undefined, { linked_account_id: "a" }),
      valuation("car", "asset", "300", "2026-03-10", undefined, { removed: true }),
    ],
  });
  expect(series.map(point => netWorth(point).get("EUR"))).toEqual([500n, 3000n, 3200n]);
  expect(series[0].debts.get("EUR")).toBe(-800n);
  expect(netWorth(series[2]).get("USD")).toBe(700n);
});

it("works balances back from the first recorded one through posted transactions, and leaves earlier dates unknown", () => {
  const series = netWorthSeries({ dates: ["2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30", "2026-10-26"], timeZone: "UTC", accountIds: new Set(["bank"]),
    snapshots: [{ account_id: "bank", amount_minor: "2711", currency_code: "EUR", as_of: "2026-10-15T09:00:00Z" }], valuations: [],
    ledger: [
      { account_id: "bank", amount_minor: "50000", currency_code: "EUR", posted_on: "2026-07-21", status: "posted" },
      { account_id: "bank", amount_minor: "-20000", currency_code: "EUR", posted_on: "2026-08-10", status: "posted" },
      { account_id: "bank", amount_minor: "-27289", currency_code: "EUR", posted_on: "2026-10-02", status: "posted" },
      { account_id: "bank", amount_minor: "-999", currency_code: "EUR", posted_on: "2026-10-03", status: "pending" },
      { account_id: "bank", amount_minor: "-500", currency_code: "EUR", posted_on: "2026-10-20", status: "posted" },
    ] });
  expect(series.map(point => [point.date, point.known, netWorth(point).get("EUR")])).toEqual([
    ["2026-06-30", false, undefined],
    ["2026-07-31", true, 50000n],
    ["2026-08-31", true, 30000n],
    ["2026-09-30", true, 30000n],
    ["2026-10-26", true, 2211n],
  ]);
});

it("rolls a recorded balance forward through later posted transactions", () => {
  const series = netWorthSeries({ dates: ["2026-10-14", "2026-10-15", "2026-10-31"], timeZone: "UTC", accountIds: new Set(["bank"]),
    snapshots: [{ account_id: "bank", amount_minor: "100000", currency_code: "EUR", as_of: "2026-10-01T00:00:00Z" }], valuations: [],
    ledger: [
      { account_id: "bank", amount_minor: "-105875", currency_code: "EUR", posted_on: "2026-10-15", status: "posted" },
      { account_id: "bank", amount_minor: "-1", currency_code: "EUR", posted_on: "2026-10-01", status: "posted" },
      { account_id: "bank", amount_minor: "-999", currency_code: "EUR", posted_on: "2026-10-20", status: "pending" },
    ] });
  expect(series.map(point => netWorth(point).get("EUR"))).toEqual([100000n, -5875n, -5875n]);
});

it("keeps postings made after a balance typed in during the day on the far side of it", () => {
  const series = netWorthSeries({ dates: ["2026-09-30", "2026-10-30", "2026-10-31"], timeZone: "UTC", accountIds: new Set(["bank"]),
    snapshots: [{ account_id: "bank", amount_minor: "100000", currency_code: "EUR", as_of: "2026-10-31T13:14:00Z" }], valuations: [],
    ledger: [
      { account_id: "bank", amount_minor: "250000", currency_code: "EUR", posted_on: "2026-10-01", status: "posted" },
      { account_id: "bank", amount_minor: "-10000", currency_code: "EUR", posted_on: "2026-10-31", posted_at: "2026-10-31T09:00:00Z", status: "posted" },
      { account_id: "bank", amount_minor: "-105875", currency_code: "EUR", posted_on: "2026-10-31", posted_at: "2026-10-31T13:18:00Z", status: "posted" },
    ] });
  expect(series.map(point => netWorth(point).get("EUR"))).toEqual([-140000n, 110000n, -5875n]);
});

it("builds today's net worth from resolved balances and current valuations only", () => {
  const point = currentNetWorth("2026-10-31", [
    { currency_code: "EUR", balance: { amount_minor: "-5875" } }, { currency_code: "EUR", balance: { amount_minor: "210132" } }, { currency_code: "EUR", balance: { amount_minor: null } },
  ], [{ amountMinor: 100000n, currencyCode: "EUR", debt: false }, { amountMinor: -20000n, currencyCode: "EUR", debt: true }]);
  expect([point.accounts.get("EUR"), point.assets.get("EUR"), point.debts.get("EUR"), netWorth(point).get("EUR")]).toEqual([204257n, 100000n, -20000n, 284257n]);
});

describe("calculated Scalable values", () => {
  const value = (on_date: string, total_minor: string) => ({ on_date, currency_code: "EUR", total_minor });
  const rows = [value("2026-10-29", "111"), value("2026-10-30", "222"), value("2026-10-31", "333"), value("2026-11-01", "999")];
  const synced = { item_id: "cash", kind: "asset", amount_minor: "500", currency_code: "EUR", as_of: "2026-10-31", created_at: "2026-10-31T10:00:00Z", linked_account_id: null };
  const bank = (as_of: string) => [{ account_id: "bank", amount_minor: "1000", currency_code: "EUR", as_of }];
  const series = (dates: string[], snapshots = bank("2026-10-01T00:00:00Z")) => netWorthSeries({ dates, timeZone: "UTC", accountIds: new Set(["bank"]), valuations: [synced], calculated: { rows, before: "2026-10-31" }, snapshots });

  it("counts only before the first synced value, so the portfolio is never counted twice", () => {
    expect(series(["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]).map(point => netWorth(point).get("EUR"))).toEqual([1111n, 1222n, 1500n, 1500n]);
  });

  it("does not start a chart before something else is known, which would draw a false jump", () => {
    const points = series(["2026-10-29", "2026-10-30"], bank("2026-10-30T00:00:00Z"));
    expect(points.map(point => [point.known, netWorth(point).get("EUR")])).toEqual([[false, undefined], [true, 1222n]]);
  });

  it("gives Home's month base the calculated value when the first sync came after it", () => {
    const [base] = netWorthSeries({ dates: ["2026-10-30"], timeZone: "UTC", accountIds: new Set(["bank"]), valuations: [{ ...synced, as_of: "2026-11-05" }], calculated: { rows, before: "2026-11-05" }, snapshots: bank("2026-10-01T00:00:00Z") });
    expect(netWorth(base).get("EUR")).toBe(1222n);
  });

  it("adds nothing without a first synced value", () => {
    const [point] = netWorthSeries({ dates: ["2026-10-30"], timeZone: "UTC", accountIds: new Set(["bank"]), valuations: [], calculated: { rows, before: null }, snapshots: bank("2026-10-01T00:00:00Z") });
    expect(netWorth(point).get("EUR")).toBe(1000n);
  });

  it("finds the first synced value among every item a sync ever wrote, and only those", () => {
    const known = scalableKnownIds([{ itemIds: ["cash"], knownItemIds: ["sold"] }, null]);
    expect([...known]).toEqual(["sold", "cash"]);
    expect(firstSyncedOn([{ ...synced, as_of: "2026-11-05" }, { ...synced, item_id: "sold", as_of: "2026-11-03" }, { ...synced, item_id: "manual", as_of: "2020-01-01" }], known)).toBe("2026-11-03");
    expect(firstSyncedOn([{ ...synced, item_id: "manual" }], known)).toBeNull();
  });
});

describe("things that change over time", () => {
  type Over = Record<string, unknown>;
  const item = (over: Over = {}) => ({ id: "fund", name: "Fund", kind: "holding", currency_code: "EUR", amount_minor: "1000", as_of: "2026-11-01", linked_account_id: null, removed_at: null, ...over });
  const event = (id: string, created_at: string, after: Over, over: Over = {}) => ({ id, item_id: "fund", before: null, after: item(after), created_at, undone_at: null, ...over });
  const total = (events: unknown[], items: unknown[], dates: string[]) => netWorthSeries({ dates, timeZone: "UTC", accountIds: new Set(), snapshots: [], valuations: valuationHistory(events as never, items as never, "UTC") })
    .map(point => netWorth(point).get("EUR") ?? 0n);
  const dates = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];

  it("counts a position sold and rebought as zero during the gap", () => {
    const events = [event("a", "2026-11-01T10:00:00Z", {}), event("b", "2026-11-02T10:00:00Z", { removed_at: "2026-11-02T10:00:00Z" }), event("c", "2026-11-05T10:00:00Z", { amount_minor: "1100", as_of: "2026-11-05" })];
    expect(total(events, [item({ amount_minor: "1100", as_of: "2026-11-05" })], dates)).toEqual([1000n, 0n, 0n, 0n, 1100n]);
  });

  it("treats an undone addition as never added, and keeps the past days of a real removal", () => {
    expect(total([event("a", "2026-11-01T10:00:00Z", {}, { undone_at: "2026-11-03T10:00:00Z" })], [item({ removed_at: "2026-11-03T10:00:00Z" })], dates)).toEqual([0n, 0n, 0n, 0n, 0n]);
    const created = event("a", "2026-11-01T10:00:00Z", {}), removal = event("b", "2026-11-03T10:00:00Z", { removed_at: "2026-11-03T10:00:00Z" });
    expect(total([created, removal], [item({ removed_at: "2026-11-03T10:00:00Z" })], dates)).toEqual([1000n, 1000n, 0n, 0n, 0n]);
    // Undoing the removal brings every day back.
    expect(total([created, { ...removal, undone_at: "2026-11-04T10:00:00Z" }], [item()], dates)).toEqual([1000n, 1000n, 1000n, 1000n, 1000n]);
  });

  it("stops counting an asset's old value from the day it is linked to an account", () => {
    const events = [event("a", "2026-11-01T10:00:00Z", {}), event("b", "2026-11-03T10:00:00Z", { as_of: "2026-11-03", linked_account_id: "bank" })];
    expect(total(events, [item({ as_of: "2026-11-03", linked_account_id: "bank" })], dates)).toEqual([1000n, 1000n, 0n, 0n, 0n]);
  });

  it("keeps a loan and its repaid amount from changing net worth, whenever you look", () => {
    const loan = (over: Over) => event("x", "2026-11-01T10:00:00Z", { name: "Lent to Sam", kind: "asset", quantity_text: null, ...over });
    const snapshots = [{ account_id: "bank", amount_minor: "90000", currency_code: "EUR", as_of: "2026-11-01T00:00:00Z" }];
    const ledger = [{ account_id: "bank", amount_minor: "4000", currency_code: "EUR", posted_on: "2026-11-03", status: "posted" }, { account_id: "bank", amount_minor: "6000", currency_code: "EUR", posted_on: "2026-11-05", status: "posted" }];
    // Lent 100.00 before the balance date; 40.00 comes back on the 3rd and the last 60.00 on the 5th.
    const events = [loan({ amount_minor: "10000" }), { ...loan({ amount_minor: "6000", as_of: "2026-11-03" }), id: "y" }, { ...loan({ amount_minor: "6000", as_of: "2026-11-03", removed_at: "2026-11-05T00:00:00Z" }), id: "z" }];
    const series = netWorthSeries({ dates, timeZone: "UTC", accountIds: new Set(["bank"]), snapshots, ledger, valuations: valuationHistory(events as never, [item({ removed_at: "2026-11-05T00:00:00Z" })] as never, "UTC") });
    expect(new Set(series.map(point => netWorth(point).get("EUR")))).toEqual(new Set([100000n]));
  });

  it("keeps an archived account in past days until its date, and counts money moved out of it once", () => {
    const snapshots = [{ account_id: "old", amount_minor: "5000", currency_code: "EUR", as_of: "2026-11-01T00:00:00Z" }, { account_id: "new", amount_minor: "100", currency_code: "EUR", as_of: "2026-11-01T00:00:00Z" }];
    const ledger = [{ account_id: "old", amount_minor: "-5000", currency_code: "EUR", posted_on: "2026-11-03", status: "posted" }, { account_id: "new", amount_minor: "5000", currency_code: "EUR", posted_on: "2026-11-03", status: "posted" }];
    const archivedOn = archiveDates([{ id: "old", archived_at: "2026-11-03T12:00:00Z" }, { id: "new", archived_at: null }], "UTC");
    const series = netWorthSeries({ dates, timeZone: "UTC", accountIds: new Set(["old", "new"]), archivedOn, snapshots, ledger, valuations: [] });
    expect(series.map(point => netWorth(point).get("EUR"))).toEqual([5100n, 5100n, 5100n, 5100n, 5100n]);
    // Old archives, closed without being asked, still drop on their date rather than rewriting the past.
    expect(netWorthSeries({ dates, timeZone: "UTC", accountIds: new Set(["old", "new"]), archivedOn, snapshots, ledger: [], valuations: [] }).map(point => netWorth(point).get("EUR"))).toEqual([5100n, 5100n, 100n, 100n, 100n]);
  });
});

describe("the graph's safeguards", () => {
  const base = { timeZone: "UTC", accountIds: new Set(["bank"]), valuations: [] };
  const snapshot = (over = {}) => ({ account_id: "bank", amount_minor: "1000", currency_code: "EUR", as_of: "2026-10-01T00:00:00Z", provenance: "bank", ...over });
  const fund = { item_id: "fund", kind: "asset", amount_minor: "500", currency_code: "EUR", as_of: "2026-09-01", created_at: "2026-09-01T00:00:00Z", linked_account_id: null };

  it("starts where accounts start, and only without any account data at the first value", () => {
    const withAccount = netWorthSeries({ ...base, dates: ["2026-09-15", "2026-10-02"], snapshots: [snapshot()], valuations: [fund] });
    expect(withAccount.map(point => point.known)).toEqual([false, true]);
    const noAccounts = netWorthSeries({ ...base, accountIds: new Set(), dates: ["2026-08-15", "2026-09-15"], snapshots: [], valuations: [fund] });
    expect(noAccounts.map(point => point.known)).toEqual([false, true]);
    const emptyAccount = netWorthSeries({ ...base, dates: ["2026-09-15"], snapshots: [], valuations: [fund] });
    expect(emptyAccount[0].known).toBe(true);
  });

  it("resolves two same-dated balances like the headline, whatever order they are read in", () => {
    const older = snapshot({ id: "a", created_at: "2026-10-01T10:00:00Z" }), newer = snapshot({ id: "b", amount_minor: "2000", created_at: "2026-10-01T11:00:00Z" });
    for (const order of [[older, newer], [newer, older]]) {
      const [point] = netWorthSeries({ ...base, dates: ["2026-10-02"], snapshots: order });
      expect(netWorth(point).get("EUR")).toBe(BigInt(resolveBalances([{ id: "bank", name: "Bank", currency_code: "EUR" }], order, [], "2026-10-02T12:00:00Z", "UTC")[0].balance.amount_minor!));
    }
  });

  it("agrees with today's balance rules on reviewed balances, and marks a day it can't prove", () => {
    const row = { id: "r", account_id: "bank", amount_minor: "-100", currency_code: "EUR", posted_on: "2026-10-01", status: "posted", version: 1 };
    const covered = [{ id: "r", version: 1, amount_minor: "-100", currency_code: "EUR", posted_on: "2026-10-01", posted_at: null }];
    const reviewed = snapshot({ boundary_kind: "reviewed_activity", as_of: "2026-10-01T12:00:00Z", covered_transactions: covered });
    const good = netWorthSeries({ ...base, dates: ["2026-09-30", "2026-10-01", "2026-10-02"], snapshots: [reviewed], ledger: [row] });
    expect(good.map(point => [netWorth(point).get("EUR"), point.uncertain])).toEqual([[1100n, []], [1000n, []], [1000n, []]]);
    // The reviewed row was corrected afterwards: the balance can't be proven any more.
    const changed = netWorthSeries({ ...base, dates: ["2026-10-02"], snapshots: [reviewed], ledger: [{ ...row, amount_minor: "-150" }] });
    expect(changed[0].uncertain).toEqual(expect.arrayContaining([expect.stringContaining("review the booked balance")]));
    expect(resolveBalances([{ id: "bank", name: "Bank", currency_code: "EUR" }], [reviewed], [{ ...row, amount_minor: "-150" }], "2026-10-02T12:00:00Z", "UTC")[0].balance.status).toBe("ambiguous");
  });

  it("treats a row imported twice the same for every reader: one canonical row, repeated closing balances", () => {
    const copies = [snapshot({ id: "a", source_transaction_id: "s1", created_at: "2026-10-01T10:00:00Z" }), snapshot({ id: "b", source_transaction_id: "s2", created_at: "2026-10-02T10:00:00Z" })];
    const ledger = [{ id: "t", account_id: "bank", amount_minor: "-100", currency_code: "EUR", posted_on: "2026-10-02", status: "posted" }];
    const [point] = netWorthSeries({ ...base, dates: ["2026-10-03"], snapshots: copies, ledger });
    const { balance } = resolveBalances([{ id: "bank", name: "Bank", currency_code: "EUR" }], copies, ledger, "2026-10-03T12:00:00Z", "UTC")[0];
    expect([netWorth(point).get("EUR"), BigInt(balance.amount_minor!), balance.conflicts.length]).toEqual([900n, 900n, 0]);
  });

  it("applies a correction only to what is counted: not before the broker has a value, and not where an account has none", () => {
    const window = { from: "2026-10-01", to: "2026-10-05", amountMinor: 700n, currencyCode: "EUR", kind: "matched" as const, broker: true, accounts: ["bank"], key: "k" };
    const dates = ["2026-10-02", "2026-10-03"];
    const rows = [{ on_date: "2026-10-03", currency_code: "EUR", total_minor: "10" }];
    const points = netWorthSeries({ ...base, dates, snapshots: [snapshot()], transit: [window], calculated: { rows, before: "2026-10-10" } });
    expect(points.map(point => point.transit.get("EUR"))).toEqual([undefined, 700n]);
    const noBank = netWorthSeries({ ...base, dates: ["2026-09-20"], snapshots: [snapshot()], transit: [{ ...window, from: "2026-09-01", broker: false }] });
    expect(noBank[0].transit.size).toBe(0);
  });
});
