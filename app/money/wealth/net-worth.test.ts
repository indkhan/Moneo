import { describe, expect, it } from "vitest";
import { currentNetWorth, dayRange, firstSyncedOn, monthEnds, netWorth, netWorthSeries, scalableKnownIds } from "./net-worth";

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
    ],
    removedOn: new Map([["car", "2026-03-10"]]),
  });
  expect(series.map(point => netWorth(point).get("EUR"))).toEqual([500n, 3000n, 3200n]);
  expect(series[0].debts.get("EUR")).toBe(-800n);
  expect(netWorth(series[2]).get("USD")).toBe(700n);
});

it("works balances back from the first recorded one through posted transactions, and leaves earlier dates unknown", () => {
  const series = netWorthSeries({ dates: ["2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30", "2026-10-26"], timeZone: "UTC", accountIds: new Set(["bank"]),
    snapshots: [{ account_id: "bank", amount_minor: "2711", currency_code: "EUR", as_of: "2026-10-15T09:00:00Z" }], valuations: [], removedOn: new Map(),
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
    snapshots: [{ account_id: "bank", amount_minor: "100000", currency_code: "EUR", as_of: "2026-10-01T00:00:00Z" }], valuations: [], removedOn: new Map(),
    ledger: [
      { account_id: "bank", amount_minor: "-105875", currency_code: "EUR", posted_on: "2026-10-15", status: "posted" },
      { account_id: "bank", amount_minor: "-1", currency_code: "EUR", posted_on: "2026-10-01", status: "posted" },
      { account_id: "bank", amount_minor: "-999", currency_code: "EUR", posted_on: "2026-10-20", status: "pending" },
    ] });
  expect(series.map(point => netWorth(point).get("EUR"))).toEqual([100000n, -5875n, -5875n]);
});

it("keeps postings made after a balance typed in during the day on the far side of it", () => {
  const series = netWorthSeries({ dates: ["2026-09-30", "2026-10-30", "2026-10-31"], timeZone: "UTC", accountIds: new Set(["bank"]),
    snapshots: [{ account_id: "bank", amount_minor: "100000", currency_code: "EUR", as_of: "2026-10-31T13:14:00Z" }], valuations: [], removedOn: new Map(),
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
  const series = (dates: string[], snapshots = bank("2026-10-01T00:00:00Z")) => netWorthSeries({ dates, timeZone: "UTC", accountIds: new Set(["bank"]), valuations: [synced], removedOn: new Map(), calculated: { rows, before: "2026-10-31" }, snapshots });

  it("counts only before the first synced value, so the portfolio is never counted twice", () => {
    expect(series(["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]).map(point => netWorth(point).get("EUR"))).toEqual([1111n, 1222n, 1500n, 1500n]);
  });

  it("does not start a chart before something else is known, which would draw a false jump", () => {
    const points = series(["2026-10-29", "2026-10-30"], bank("2026-10-30T00:00:00Z"));
    expect(points.map(point => [point.known, netWorth(point).get("EUR")])).toEqual([[false, undefined], [true, 1222n]]);
  });

  it("gives Home's month base the calculated value when the first sync came after it", () => {
    const [base] = netWorthSeries({ dates: ["2026-10-30"], timeZone: "UTC", accountIds: new Set(["bank"]), valuations: [{ ...synced, as_of: "2026-11-05" }], removedOn: new Map(), calculated: { rows, before: "2026-11-05" }, snapshots: bank("2026-10-01T00:00:00Z") });
    expect(netWorth(base).get("EUR")).toBe(1222n);
  });

  it("adds nothing without a first synced value", () => {
    const [point] = netWorthSeries({ dates: ["2026-10-30"], timeZone: "UTC", accountIds: new Set(["bank"]), valuations: [], removedOn: new Map(), calculated: { rows, before: null }, snapshots: bank("2026-10-01T00:00:00Z") });
    expect(netWorth(point).get("EUR")).toBe(1000n);
  });

  it("finds the first synced value among every item a sync ever wrote, and only those", () => {
    const known = scalableKnownIds([{ itemIds: ["cash"], knownItemIds: ["sold"] }, null]);
    expect([...known]).toEqual(["sold", "cash"]);
    expect(firstSyncedOn([{ ...synced, as_of: "2026-11-05" }, { ...synced, item_id: "sold", as_of: "2026-11-03" }, { ...synced, item_id: "manual", as_of: "2020-01-01" }], known)).toBe("2026-11-03");
    expect(firstSyncedOn([{ ...synced, item_id: "manual" }], known)).toBeNull();
  });
});
