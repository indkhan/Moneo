import { calendarDate } from "@/lib/finance/calendar";
import { valuationHistory } from "@/lib/finance/net-worth";
import { decimalRatio, holdingValue, type WealthItem } from "@/lib/finance/wealth";
import { positionChartView, type PositionChartView } from "./chart-view";
import type { PositionChart } from "./charts";
import { delta, directionOf, percentText, type Delta, type Direction } from "./delta";
import { toMinor } from "./live";
import { valueHistoryView, type ValueEntry, type ValueHistoryView } from "./value-history";

type Format = { money: (minor: bigint | string, currency: string) => string; date: (value: string) => string; dateTime: (value: string) => string };
export type HoldingTrade = PositionChart["trades"][number];
export type HoldingEvents = Parameters<typeof valuationHistory>[0];
export type HoldingView = {
  name: string; isin: string | null;
  facts: { label: string; value: string; direction?: Direction }[];
  history: ValueHistoryView; historyNote: string | null;
  periods: { label: string; from: string; then: string; now: string; change: Delta }[];
  prices: PositionChartView;
  trades: { when: string; side: "Bought" | "Sold"; quantity: string; price: string | null; amount: string | null }[];
};

const PERIOD_NAMES = { one_day: "Latest market day", seven_days: "1 week", one_month: "1 month", one_year: "1 year", max: "All time" };
const SCALE = 10n ** 18n, TOLERANCE = 10n ** 12n;
const scaled = (quantity: string) => { const ratio = decimalRatio(quantity); return ratio.numerator * SCALE / ratio.denominator; };
const decimalOf = (value: bigint) => `${value / SCALE}.${(value % SCALE).toString().padStart(18, "0")}`.replace(/\.?0+$/, "");
const signedShares = (trade: HoldingTrade) => trade.side === "BUY" ? scaled(trade.quantity) : -scaled(trade.quantity);
const byTime = (a: { at: string }, b: { at: string }) => Date.parse(a.at) - Date.parse(b.at);

function recordedEntries(item: WealthItem, events: HoldingEvents, timeZone: string): ValueEntry[] {
  const history = valuationHistory(events.filter(event => event.item_id === item.id), [item], timeZone) as (ReturnType<typeof valuationHistory>[number] & Pick<WealthItem, "quantity_text" | "unit_price_text">)[];
  const latest = new Map<string, (typeof history)[number]>();
  for (const row of history) {
    const known = latest.get(row.as_of);
    if (row.currency_code === item.currency_code && (!known || row.created_at > known.created_at)) latest.set(row.as_of, row);
  }
  const days = [...latest.values()].sort((a, b) => a.as_of.localeCompare(b.as_of));
  return days.slice(Math.max(days.findIndex(row => !row.removed), 0)).map(row => ({
    date: row.as_of, calculated: false, trades: [],
    valueMinor: row.removed ? 0n : BigInt(row.amount_minor),
    priceMinor: row.removed || !row.unit_price_text ? null : BigInt(toMinor(row.unit_price_text, item.currency_code)),
    shares: row.removed ? "0" : row.quantity_text,
  }));
}

function tradesAddUp(trades: HoldingTrade[], sharesNow: bigint) {
  let held = 0n;
  for (const trade of trades) {
    held += signedShares(trade);
    if (held < -TOLERANCE) return false;
  }
  return held - sharesNow <= TOLERANCE && sharesNow - held <= TOLERANCE;
}

function dailyPrices(chart: PositionChart, trades: HoldingTrade[], currency: string, timeZone: string) {
  const quotes = [...chart.periods.filter(period => period.currency === currency).flatMap(period => period.points),
    ...trades.flatMap(trade => trade.price ? [{ at: trade.at, price: trade.price }] : [])].sort(byTime);
  return [...new Map(quotes.map(quote => [calendarDate(quote.at, timeZone), quote.price]))].sort(([a], [b]) => a.localeCompare(b));
}

function calculatedEntries(chart: PositionChart, trades: HoldingTrade[], currency: string, timeZone: string, before: string | undefined): ValueEntry[] {
  const [first] = trades;
  if (!first) return [];
  const from = calendarDate(first.at, timeZone);
  const traded = trades.map(trade => ({ day: calendarDate(trade.at, timeZone), shares: signedShares(trade) }));
  return dailyPrices(chart, trades, currency, timeZone).filter(([date]) => date >= from && (!before || date < before)).map(([date, price]) => {
    const held = traded.reduce((sum, trade) => trade.day <= date ? sum + trade.shares : sum, 0n);
    const shares = held > TOLERANCE ? decimalOf(held) : "0";
    return { date, calculated: true, trades: [], shares, priceMinor: BigInt(toMinor(price, currency)), valueMinor: shares === "0" ? 0n : holdingValue(shares, price, currency) };
  });
}

function withTrades(entries: ValueEntry[], trades: HoldingTrade[], timeZone: string): ValueEntry[] {
  return entries.map((entry, index) => {
    const since = entries[index - 1]?.date;
    return { ...entry, trades: trades.filter(trade => { const day = calendarDate(trade.at, timeZone); return since ? day > since && day <= entry.date : day === entry.date; }) };
  });
}

export function holdingEntries({ item, events, chart, timeZone }: { item: WealthItem; events: HoldingEvents; chart: PositionChart; timeZone: string }): { entries: ValueEntry[]; note: string | null } {
  const recorded = recordedEntries(item, events, timeZone);
  const trades = [...chart.trades].sort(byTime);
  const complete = trades.length > 0 && !!item.quantity_text && tradesAddUp(trades, scaled(item.quantity_text));
  const calculated = complete ? calculatedEntries(chart, trades, item.currency_code, timeZone, recorded[0]?.date) : [];
  const note = complete ? null : trades.length
    ? "The stored trades don't add up to the shares you hold now (a transfer, split or older trade is missing), so Moneo can't work out values from before it first synced this holding."
    : "No trades of this holding are stored, so its value history starts at the first Scalable sync that saw it.";
  return { entries: withTrades([...calculated, ...recorded], trades, timeZone), note };
}

function holdingFacts(item: WealthItem, chart: PositionChart, portfolioTotalMinor: bigint | null, trades: HoldingTrade[], format: Format) {
  const currency = item.currency_code, money = (minor: bigint) => format.money(minor, currency);
  const value = BigInt(item.amount_minor), cost = item.cost_basis_minor === null ? null : BigInt(item.cost_basis_minor);
  const shares = item.quantity_text ? scaled(item.quantity_text) : 0n;
  const yearPrices = chart.periods.find(period => period.timeframe === "one_year" && period.currency === currency)?.points.map(point => BigInt(toMinor(point.price, currency))) ?? [];
  const firstBuy = trades.find(trade => trade.side === "BUY");
  const bought = trades.filter(trade => trade.side === "BUY").length;
  const facts: HoldingView["facts"] = [{ label: "Value", value: money(value) }];
  if (item.unit_price_text) facts.push({ label: "Price per share", value: money(BigInt(toMinor(item.unit_price_text, currency))) });
  if (item.quantity_text) facts.push({ label: "Shares", value: item.quantity_text });
  if (cost !== null && shares > 0n) facts.push({ label: "Average buy price", value: money((cost * SCALE * 2n + shares) / (shares * 2n)) });
  if (cost !== null) {
    const gain = value - cost;
    facts.push({ label: "Amount invested", value: money(cost) });
    facts.push({ label: "Unrealised gain or loss", direction: directionOf(gain), value: [`${gain > 0n ? "+" : ""}${money(gain)}`, percentText(gain, cost)].filter(Boolean).join(" · ") });
  }
  const weight = portfolioTotalMinor === null ? null : percentText(value, portfolioTotalMinor);
  if (weight) facts.push({ label: "Share of Scalable portfolio", value: weight.replace("+", "") });
  if (yearPrices.length) facts.push({ label: "1-year price range", value: `${money(yearPrices.reduce((a, b) => b < a ? b : a))} – ${money(yearPrices.reduce((a, b) => b > a ? b : a))}` });
  if (firstBuy) facts.push({ label: "First stored buy", value: format.date(firstBuy.at) });
  if (trades.length) facts.push({ label: "Stored trades", value: `${bought} buy · ${trades.length - bought} sell` });
  facts.push({ label: "Valued on", value: format.date(item.as_of) });
  return facts;
}

function periodMoves(chart: PositionChart, format: Format): HoldingView["periods"] {
  return chart.periods.flatMap(period => {
    const first = period.points[0], last = period.points.at(-1);
    if (!first || !last) return [];
    const then = BigInt(toMinor(first.price, period.currency)), now = BigInt(toMinor(last.price, period.currency));
    return [{ label: PERIOD_NAMES[period.timeframe], from: format.date(first.at), then: format.money(then, period.currency), now: format.money(now, period.currency), change: delta(then, now, period.currency, format.money) }];
  });
}

export function holdingView({ item, isin, events, chart, portfolioTotalMinor, timeZone, format }: {
  item: WealthItem; isin: string | null; events: HoldingEvents; chart: PositionChart; portfolioTotalMinor: bigint | null; timeZone: string; format: Format;
}): HoldingView {
  const currency = item.currency_code;
  const trades = [...chart.trades].sort(byTime);
  const { entries, note } = holdingEntries({ item, events, chart, timeZone });
  return {
    name: item.name, isin,
    facts: holdingFacts(item, chart, portfolioTotalMinor, trades, format),
    history: valueHistoryView(entries, currency, format),
    historyNote: note,
    periods: periodMoves(chart, format),
    prices: positionChartView(chart, format),
    trades: trades.reverse().map(trade => ({
      when: format.dateTime(trade.at), side: trade.side === "BUY" ? "Bought" : "Sold", quantity: trade.quantity,
      price: trade.price ? format.money(toMinor(trade.price, currency), currency) : null,
      amount: trade.price ? format.money(holdingValue(trade.quantity, trade.price, currency), currency) : null,
    })),
  };
}
