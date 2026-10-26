import { expect, it } from "vitest";
import { dayRange, monthEnds, netWorth, netWorthSeries } from "./net-worth";

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
    ["2026-10-26", true, 2711n],
  ]);
});
