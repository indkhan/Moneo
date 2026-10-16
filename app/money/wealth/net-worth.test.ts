import { expect, it } from "vitest";
import { monthEnds, netWorth, netWorthSeries } from "./net-worth";

it("lists month ends then today", () => {
  expect(monthEnds("2026-03-15", 3)).toEqual(["2025-12-31", "2026-01-31", "2026-02-28", "2026-03-15"]);
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
