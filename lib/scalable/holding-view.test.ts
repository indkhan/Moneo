import { expect, it } from "vitest";
import type { WealthItem } from "@/lib/finance/wealth";
import type { PositionChart } from "./charts";
import { holdingEntries, holdingView, type HoldingEvents } from "./holding-view";
import { valueHistoryView } from "./value-history";

const item = { id: "h", kind: "holding", name: "World ETF", currency_code: "EUR", amount_minor: "36000", quantity_text: "3", unit_price_text: "120", cost_basis_minor: "31000",
  as_of: "2026-10-20", linked_account_id: null, removed_at: null } as WealthItem;
const events = [{ id: "e", item_id: "h", before: null, created_at: "2026-10-19T08:00:00Z", undone_at: null,
  after: { ...item, as_of: "2026-10-19", amount_minor: "33900", unit_price_text: "113" } }] as HoldingEvents;
const quote = (day: string, price: string) => ({ at: `${day}T20:00:00Z`, price });
const chart = (trades: PositionChart["trades"]): PositionChart => ({ trades, periods: [{ timeframe: "one_month", label: "1M", currency: "EUR", fetchedAt: "2026-10-20T08:00:00Z",
  points: [quote("2026-10-01", "100"), quote("2026-10-05", "105"), quote("2026-10-10", "110.10"), quote("2026-10-19", "999"), quote("2026-10-20", "999")] }] });
const bought = (day: string, quantity: string) => ({ at: `${day}T09:00:00Z`, side: "BUY" as const, quantity, price: null });
const entries = (trades: PositionChart["trades"]) => holdingEntries({ item, events, chart: chart(trades), timeZone: "UTC" });

it("values the days before the first sync from the shares held then, and keeps Scalable's own values from that sync on", () => {
  const { entries: found, note } = entries([bought("2026-10-01", "2"), bought("2026-10-07", "1.5"), { at: "2026-10-09T09:00:00Z", side: "SELL", quantity: "0.5", price: null }]);
  expect(note).toBeNull();
  expect(found.map(entry => [entry.date, entry.shares, entry.valueMinor, entry.calculated])).toEqual([
    ["2026-10-01", "2", 20000n, true], ["2026-10-05", "2", 21000n, true], ["2026-10-10", "3", 33030n, true],
    ["2026-10-19", "3", 33900n, false], ["2026-10-20", "3", 36000n, false],
  ]);
});

it("works out nothing before the first sync when the stored trades don't add up to the shares held", () => {
  for (const trades of [[bought("2026-10-01", "2")], [], [{ at: "2026-10-01T09:00:00Z", side: "SELL" as const, quantity: "1", price: null }, bought("2026-10-05", "4")]]) {
    const { entries: found, note } = entries(trades);
    expect(found.map(entry => [entry.date, entry.valueMinor])).toEqual([["2026-10-19", 33900n], ["2026-10-20", 36000n]]);
    expect(note).not.toBeNull();
  }
});

it("compares each month with the one before it and keeps the month's trades", () => {
  const entry = (date: string, valueMinor: bigint, trades: { side: "BUY" | "SELL"; quantity: string }[] = []) => ({ date, valueMinor, priceMinor: null, shares: null, calculated: false, trades });
  const view = valueHistoryView([entry("2026-08-31", 10000n), entry("2026-09-10", 20000n, [{ side: "BUY", quantity: "1" }]), entry("2026-09-30", 12500n)],
    "EUR", { money: minor => String(minor), date: value => value });
  expect(view.months.map(row => [row.label, row.value, row.change?.amount ?? null, row.change?.percent ?? null, row.trades]))
    .toEqual([["2026-09-30", "12500", "+2500", "+25.00%", "Bought 1"], ["2026-08-31", "10000", null, null, null]]);
});

it("reports average buy price, unrealised gain and portfolio share from minor units", () => {
  const view = holdingView({ item, isin: null, events, chart: chart([]), portfolioTotalMinor: 144000n, timeZone: "UTC",
    format: { money: minor => String(minor), date: value => value, dateTime: value => value } });
  const facts = Object.fromEntries(view.facts.map(fact => [fact.label, fact.value]));
  expect(facts["Average buy price"]).toBe("10333");
  expect(facts["Unrealised gain or loss"]).toBe("+5000 · +16.12%");
  expect(facts["Share of Scalable portfolio"]).toBe("25.00%");
});
