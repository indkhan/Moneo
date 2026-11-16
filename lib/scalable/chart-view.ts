import type { PositionChart } from "./charts";
import { toMinor } from "./live";

type Format = { money: (minor: bigint | string, currency: string) => string; dateTime: (value: string) => string };
export type PositionChartView = { key: string; label: string; asOf: string; change: { text: string; direction: "up" | "down" | "flat" } | null;
  points: { date: string; label: string; amount: string; y: number }[]; markers: { index: number; side: "BUY" | "SELL"; label: string }[] }[];

export function positionChartView(chart: PositionChart, format: Format): PositionChartView {
  return chart.periods.map(period => {
    const points = period.points.map(point => ({ date: point.at, label: format.dateTime(point.at), amount: format.money(toMinor(point.price, period.currency), period.currency), y: Number(point.price) }));
    const times = period.points.map(point => Date.parse(point.at)), first = times[0], last = times.at(-1)!;
    const markers = chart.trades.flatMap(trade => {
      const at = Date.parse(trade.at);
      if (at < first || at > last) return [];
      const index = times.reduce((best, time, candidate) => Math.abs(time - at) < Math.abs(times[best] - at) ? candidate : best, 0);
      return [{ index, side: trade.side, label: `${trade.side === "BUY" ? "Bought" : "Sold"} ${trade.quantity} on ${format.dateTime(trade.at)}` }];
    });
    const start = BigInt(toMinor(period.points[0].price, period.currency)), end = BigInt(toMinor(period.points.at(-1)!.price, period.currency)), moved = end - start;
    const percent = start > 0n ? Number(moved * 10000n / start) / 100 : null;
    const change = percent === null ? null : { direction: moved > 0n ? "up" as const : moved < 0n ? "down" as const : "flat" as const,
      text: `${moved > 0n ? "+" : ""}${format.money(moved, period.currency)} (${moved > 0n ? "+" : ""}${percent.toFixed(2)}%)` };
    return { key: period.timeframe, label: period.label, asOf: format.dateTime(period.fetchedAt), change, points, markers };
  });
}
