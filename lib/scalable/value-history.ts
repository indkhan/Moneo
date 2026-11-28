import { delta, type Delta } from "./delta";

type Format = { money: (minor: bigint | string, currency: string) => string; date: (value: string) => string };
export type ValueEntry = { date: string; valueMinor: bigint; priceMinor: bigint | null; shares: string | null; calculated: boolean; trades: { side: "BUY" | "SELL"; quantity: string }[] };
export type ValueRow = { date: string; label: string; value: string; change: Delta | null; shares: string | null; price: string | null; priceChange: Delta | null; trades: string | null; calculated: boolean };
export type ValueHistoryView = { points: { date: string; label: string; amount: string; y: number }[]; days: ValueRow[]; months: ValueRow[]; calculatedBefore: string | null };

const DAY_ROWS = 30;

function rows(entries: ValueEntry[], currency: string, format: Format): ValueRow[] {
  return entries.map((entry, index) => {
    const previous = entries[index - 1];
    return {
      date: entry.date, label: format.date(entry.date), value: format.money(entry.valueMinor, currency), shares: entry.shares, calculated: entry.calculated,
      change: previous ? delta(previous.valueMinor, entry.valueMinor, currency, format.money) : null,
      price: entry.priceMinor === null ? null : format.money(entry.priceMinor, currency),
      priceChange: previous && previous.priceMinor !== null && entry.priceMinor !== null ? delta(previous.priceMinor, entry.priceMinor, currency, format.money) : null,
      trades: entry.trades.map(trade => `${trade.side === "BUY" ? "Bought" : "Sold"} ${trade.quantity}`).join(" · ") || null,
    };
  }).reverse();
}

function lastOfEachMonth(entries: ValueEntry[]) {
  const months = new Map<string, ValueEntry>();
  for (const entry of entries) {
    const month = entry.date.slice(0, 7);
    months.set(month, { ...entry, trades: [...months.get(month)?.trades ?? [], ...entry.trades] });
  }
  return [...months.values()];
}

export function valueHistoryView(entries: ValueEntry[], currency: string, format: Format): ValueHistoryView {
  const firstRecorded = entries.find(entry => !entry.calculated);
  return {
    points: entries.map(entry => ({ date: entry.date, label: format.date(entry.date), amount: format.money(entry.valueMinor, currency), y: Number(entry.valueMinor) })),
    days: rows(entries, currency, format).slice(0, DAY_ROWS),
    months: rows(lastOfEachMonth(entries), currency, format),
    calculatedBefore: entries.some(entry => entry.calculated) && firstRecorded ? format.date(firstRecorded.date) : null,
  };
}
