import { expect, it } from "vitest";
import { positionChartView } from "./chart-view";
import type { PositionChart } from "./charts";

const format = { money: (minor: bigint | string, currency: string) => `${currency} ${minor}`, dateTime: (value: string) => value };
const chart = (trades: PositionChart["trades"]): PositionChart => ({ trades, periods: [{ timeframe: "one_month", label: "1M", currency: "EUR", fetchedAt: "2026-10-10T06:00:00Z",
  points: [{ at: "2026-10-01T00:00:00Z", price: "10.00" }, { at: "2026-10-05T00:00:00Z", price: "11.00" }, { at: "2026-10-10T00:00:00Z", price: "12.50" }] }] });

it("marks each trade at the nearest price point and leaves out trades outside the period", () => {
  const [view] = positionChartView(chart([{ at: "2026-10-04T12:00:00Z", side: "BUY", quantity: "2" }, { at: "2026-09-01T00:00:00Z", side: "SELL", quantity: "1" }]), format);
  expect(view.markers).toEqual([{ index: 1, side: "BUY", label: "Bought 2 on 2026-10-04T12:00:00Z" }]);
});

it("reports the move over the period in exact minor units and the as-of time of the sync", () => {
  const [view] = positionChartView(chart([]), format);
  expect(view.change).toEqual({ direction: "up", text: "+EUR 250 (+25.00%)" });
  expect(view.asOf).toBe("2026-10-10T06:00:00Z");
});
