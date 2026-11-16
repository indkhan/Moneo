import { expect, it, vi } from "vitest";
import { historyTradeRows, readCharts, thinned, tradeRows } from "./charts";

vi.mock("@/lib/bank/server", () => ({ serviceDb: vi.fn() }));

const reply = (...points: [string, number | string | null][]) => ({ currency: "EUR", dataPoints: points.map(([timestampUtc, midPrice]) => ({ timestampUtc, midPrice })) });

it("keeps a chart's prices as the decimal text Scalable sent and leaves out points without a usable price", async () => {
  const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => args.timeframe === "one_day"
    ? reply(["2026-10-02T09:00:00Z", "12.3456789"], ["2026-10-02T08:00:00Z", 0.0000001], ["2026-10-02T10:00:00Z", null], ["2026-10-02T11:00:00Z", 0])
    : reply());
  const { rows, failed } = await readCharts({ callTool }, ["IE00B4L5Y983"], "2026-10-02T12:00:00.000Z");
  expect(failed).toBe(0);
  expect(rows).toEqual([{ isin: "IE00B4L5Y983", timeframe: "one_day", currency_code: "EUR", fetched_at: "2026-10-02T12:00:00.000Z",
    points: [{ at: "2026-10-02T08:00:00.000Z", price: "0.0000001" }, { at: "2026-10-02T09:00:00.000Z", price: "12.3456789" }] }]);
});

it("still stores the other periods when one period's request fails", async () => {
  const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    if (args.timeframe === "max") throw new Error("Scalable timed out");
    return reply(["2026-10-02T09:00:00Z", "5"]);
  });
  const { rows, failed } = await readCharts({ callTool }, ["IE00B4L5Y983", "US0378331005"], "2026-10-02T12:00:00.000Z");
  expect(failed).toBe(2);
  expect(rows.map(row => `${row.isin} ${row.timeframe}`).sort()).toEqual(["IE00B4L5Y983 one_day", "IE00B4L5Y983 one_month", "IE00B4L5Y983 one_year", "IE00B4L5Y983 seven_days",
    "US0378331005 one_day", "US0378331005 one_month", "US0378331005 one_year", "US0378331005 seven_days"]);
});

it("thins a long chart to its limit and keeps the first and last point", () => {
  const long = Array.from({ length: 1000 }, (_, index) => index);
  const short = thinned(long, 240);
  expect(short).toHaveLength(240);
  expect([short[0], short.at(-1)]).toEqual([0, 999]);
  expect(thinned([1, 2, 3], 240)).toEqual([1, 2, 3]);
});

it("takes only settled, uncancelled buys and sells from the transaction list", () => {
  const security = (id: string, status: string, side: string, quantity: number | string, extra: object = {}) =>
    ({ id, status, lastEventAt: "2026-10-01T08:00:00Z", security: { isin: "IE00B4L5Y983", side, quantity }, ...extra });
  const rows = tradeRows({ transactions: [security("a", "SETTLED", "BUY", 2), security("b", "SETTLED", "sell", "-1.5"), security("c", "PENDING", "BUY", 1),
    security("d", "SETTLED", "BUY", 1, { isCancellation: true }), security("e", "SETTLED", "BUY", 0), security("f", "SETTLED", "DIVIDEND", 1),
    { id: "g", status: "SETTLED", lastEventAt: "2026-10-01T08:00:00Z", cash: { amount: 10 } }] });
  expect(rows).toEqual([{ provider_id: "a", isin: "IE00B4L5Y983", side: "BUY", occurred_at: "2026-10-01T08:00:00Z", quantity_text: "2" },
    { provider_id: "b", isin: "IE00B4L5Y983", side: "SELL", occurred_at: "2026-10-01T08:00:00Z", quantity_text: "1.5" }]);
});

it("takes the trades of the full history read and not its cash or crypto rows", () => {
  expect(historyTradeRows([{ id: "a", at: "2026-10-01T08:00:00Z", kind: "security", isin: "IE00B4L5Y983", side: "SELL", quantity: "3", amountText: "9" },
    { id: "b", at: "2026-10-01T08:00:00Z", kind: "cash", amountText: "9" },
    { id: "c", at: "2026-10-01T08:00:00Z", kind: "crypto", isin: "GB00BJYDH287", side: "BUY", quantity: "1", amountText: "-9" }]))
    .toEqual([{ provider_id: "a", isin: "IE00B4L5Y983", side: "SELL", occurred_at: "2026-10-01T08:00:00Z", quantity_text: "3" }]);
});
