import { z } from "zod";
import { dayRange } from "@/app/money/wealth/net-worth";
import { calendarDate } from "@/lib/finance/calendar";
import { decimalRatio, holdingValue } from "@/lib/finance/wealth";
import type { ScalableMcp } from "./client";
import { toMinor } from "./live";
import { decimalText } from "./portfolio";

// Past daily values of a Scalable portfolio, worked out from its own transactions and price charts. This is a
// calculation, not a record: it is saved apart from wealth_items and wealth_events, and only after replaying
// everything lands on today's real holdings and cash.

const CURRENCY = "EUR";
const PAGE_SIZE = 100, MAX_PAGES = 1000;
// Sparse far back, close to daily recently; merged so every date gets the best price available.
const TIMEFRAMES = ["max", "one_year", "six_months", "year_to_date"];

type Chart = { currency: string; points: { at: string; price: string }[] };
export type HistoryRow = { id: string; at: string; currency?: string } & (
  | { kind: "security"; isin: string; side: string; quantity: string | null; amountText: string }
  | { kind: "cash"; quantity?: undefined; amountText: string }
  | { kind: "crypto"; ticker: string; side: string; quantity: string | null; amountText: string });
export type HistoryInput = {
  rows: HistoryRow[]; charts: Record<string, Chart>; coinCharts: Record<string, Chart>;
  holdings: { isin: string; filled: number | string; currency: string }[]; coins: { ticker: string; filled: number | string }[];
  cashBalance: number | string; cryptoValue: number | string; timeZone: string;
  /** The date of the first real synced value: days stop before it. */
  before: string;
};
export type HistoryDay = { date: string; securitiesMinor: bigint; cryptoMinor: bigint; cashMinor: bigint; totalMinor: bigint };
export type HistoryResult = { ok: true; days: HistoryDay[] } | { ok: false; reason: string };

const decimal = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/)]);
const text = (value: number | string) => typeof value === "number" ? decimalText(value) : value;
const nextCursor = z.object({ nextCursor: z.string().nullish() });
const transactionsSchema = z.object({
  page: nextCursor.optional(),
  transactions: z.array(z.object({ id: z.string(), status: z.string(), currency: z.string().nullish(), isCancellation: z.boolean().nullish(), lastEventAt: z.string(),
    security: z.object({ isin: z.string(), side: z.string().nullish(), quantity: decimal.nullish(), amount: decimal.nullish() }).nullish(),
    cash: z.object({ amount: decimal.nullish() }).nullish() })).default([]),
  crypto: z.object({ page: nextCursor.optional(), transactions: z.array(z.object({ id: z.string(), status: z.string(), isCancellation: z.boolean().nullish(), lastEventAt: z.string(),
    ticker: z.string(), side: z.string().nullish(), coinQuantity: decimal.nullish(), amount: decimal.nullish() })).default([]) }).nullish(),
});
const holdingsSchema = z.object({
  holdings: z.array(z.object({ isin: z.string(), position: z.object({ filled: decimal }), currentQuote: z.object({ currency: z.string() }) })).default([]),
  cryptoHoldings: z.array(z.object({ ticker: z.string(), position: z.object({ filled: decimal }).nullish(), etpPositions: z.array(z.object({ isin: z.string() })).nullish() })).default([]),
});
const chartSchema = z.object({ currency: z.string().nullish(), dataPoints: z.array(z.object({ midPrice: decimal.nullish(), timestampUtc: z.string() })).default([]) });
const settled = (row: { status: string; isCancellation?: boolean | null }) => row.status === "SETTLED" && !row.isCancellation;

/** Every settled trade and cash move. Security and crypto rows page separately, and a stream whose cursor runs out starts over if asked again. */
async function readRows(mcp: Pick<ScalableMcp, "callTool">) {
  const securities = new Map<string, HistoryRow>(), crypto = new Map<string, HistoryRow>();
  let cursor: string | undefined, cryptoCursor: string | undefined, securitiesDone = false, cryptoDone = false;
  for (let page = 0; !securitiesDone || !cryptoDone; page++) {
    if (page === MAX_PAGES) throw new Error("Scalable transactions never finished paging");
    const reply = transactionsSchema.parse(await mcp.callTool("list_portfolio_transactions", { pageSize: PAGE_SIZE, ...(cursor ? { cursor } : {}), ...(cryptoCursor ? { cryptoCursor } : {}) }));
    if (!securitiesDone) for (const row of reply.transactions.filter(settled)) {
      const base = { id: row.id, at: row.lastEventAt, ...(row.currency ? { currency: row.currency } : {}) };
      if (row.security) securities.set(row.id, { ...base, kind: "security", isin: row.security.isin, side: row.security.side ?? "unknown", quantity: row.security.quantity == null ? null : text(row.security.quantity), amountText: String(row.security.amount ?? 0) });
      else if (row.cash) securities.set(row.id, { ...base, kind: "cash", amountText: String(row.cash.amount ?? 0) });
      // nonTradeSecurity and eltif rows say nothing reliable about quantity; if they matter, the check below fails.
    }
    if (!cryptoDone) for (const row of (reply.crypto?.transactions ?? []).filter(settled))
      crypto.set(row.id, { id: row.id, at: row.lastEventAt, kind: "crypto", ticker: row.ticker, side: row.side ?? "unknown", quantity: row.coinQuantity == null ? null : text(row.coinQuantity), amountText: String(row.amount ?? 0) });
    cursor = securitiesDone ? undefined : reply.page?.nextCursor || undefined;
    cryptoCursor = cryptoDone ? undefined : reply.crypto?.page?.nextCursor || undefined;
    securitiesDone = !cursor; cryptoDone = !cryptoCursor;
  }
  return [...securities.values(), ...crypto.values()];
}

async function readChart(mcp: Pick<ScalableMcp, "callTool">, isin: string): Promise<Chart> {
  const replies: z.infer<typeof chartSchema>[] = [];
  for (const timeframe of TIMEFRAMES) replies.push(chartSchema.parse(await mcp.callTool("get_security_chart", { isin, timeframe })));
  const points = new Map(replies.flatMap(reply => reply.dataPoints.flatMap(point => point.midPrice != null && Number(point.midPrice) > 0 ? [[point.timestampUtc, text(point.midPrice)] as const] : [])));
  return { currency: replies.find(reply => reply.dataPoints.length && reply.currency !== CURRENCY)?.currency ?? CURRENCY, points: [...points].map(([at, price]) => ({ at, price })) };
}

/** Everything the calculation needs, through Scalable's read tools only. A security chart that fails stops the run, to retry another day. */
export async function readHistoryInput(mcp: Pick<ScalableMcp, "callTool">, timeZone: string, before: string): Promise<HistoryInput> {
  const rows = await readRows(mcp);
  const holdings = holdingsSchema.parse(await mcp.callTool("get_portfolio_holdings"));
  const cash = z.object({ cash: z.object({ cashBalance: decimal }) }).parse(await mcp.callTool("get_portfolio_cash_breakdown"));
  const overview = z.object({ valuation: z.object({ crypto: decimal.default(0) }) }).parse(await mcp.callTool("get_portfolio_overview"));
  const charts: Record<string, Chart> = {}, coinCharts: Record<string, Chart> = {};
  for (const isin of new Set(rows.flatMap(row => row.kind === "security" ? [row.isin] : []))) charts[isin] = await readChart(mcp, isin);
  // Crypto has no chart of its own, so a coin follows the first of its ETPs with a usable one.
  const traded = new Set(rows.flatMap(row => row.kind === "crypto" ? [row.ticker] : []));
  for (const coin of holdings.cryptoHoldings.filter(coin => traded.has(coin.ticker))) for (const etp of coin.etpPositions ?? []) {
    const chart = await readChart(mcp, etp.isin).catch(() => null);
    if (chart?.points.length && chart.currency === CURRENCY) { coinCharts[coin.ticker] = chart; break; }
  }
  return { rows, charts, coinCharts, timeZone, before, cashBalance: cash.cash.cashBalance, cryptoValue: overview.valuation.crypto,
    holdings: holdings.holdings.map(holding => ({ isin: holding.isin, filled: holding.position.filled, currency: holding.currentQuote.currency })),
    coins: holdings.cryptoHoldings.map(coin => ({ ticker: coin.ticker, filled: coin.position?.filled ?? 0 })) };
}

// Shares, coins and prices are fixed-point bigints with 18 decimals, so nothing drifts the way floats do.
const ONE = 10n ** 18n, TOLERANCE = 10n ** 12n /* a millionth of a share */, CASH_TOLERANCE = 100n /* one euro */;
const CENTS = 100n, CENT_SCALE = ONE / CENTS;
const scaled = (value: number | string) => { const ratio = decimalRatio(text(value)); return ratio.numerator * ONE / ratio.denominator; };
const decimalOf = (value: bigint) => `${value / ONE}.${(value % ONE).toString().padStart(18, "0")}`;
const multiply = (a: bigint, b: bigint) => a * b / ONE;
const divide = (a: bigint, b: bigint) => a * ONE / b;
const value = (quantity: bigint, price: bigint) => holdingValue(decimalOf(quantity), decimalOf(price), CURRENCY);
const absolute = (minor: bigint) => minor < 0n ? -minor : minor;
/** The price per unit each trade paid, oldest first; a trade with no money or quantity says nothing. */
const tradePrices = (rows: Exclude<HistoryRow, { kind: "cash" }>[]) => rows.flatMap(row => {
  const minor = BigInt(toMinor(row.amountText, CURRENCY)), quantity = scaled(row.quantity!);
  return minor !== 0n && quantity > 0n ? [{ at: row.at, price: absolute(minor) * CENT_SCALE * ONE / quantity }] : [];
});

type Prices = { points: { day: string; at: number; price: bigint }[]; next: number; current: bigint | null };
function pricesFrom(chart: Chart | undefined, timeZone: string, trades: { at: string; price: bigint }[] = []): Prices {
  const points = [...(chart?.points ?? []).map(point => ({ at: point.at, price: scaled(point.price) })), ...trades]
    .map(point => ({ day: calendarDate(point.at, timeZone), at: Date.parse(point.at), price: point.price })).sort((a, b) => a.at - b.at);
  return { points, next: 0, current: null };
}
/** The latest price on or before `date`, which must only move forward; a price is never interpolated. */
function priceOn(prices: Prices, date: string) {
  while (prices.next < prices.points.length && prices.points[prices.next].day <= date) prices.current = prices.points[prices.next++].price;
  return prices.current;
}

type Coin = { coins: bigint; costMinor: bigint; prices: Prices; unit: bigint | null };

/**
 * How many coin prices one ETP price is worth. Each coin starts from its own last trade; the coins still held are
 * then scaled together so they add up to today's real crypto value. With one coin held the trade cancels out,
 * leaving etpPrice(date) × coinPriceToday / etpPriceToday.
 */
function coinUnits(input: HistoryInput, rows: Extract<HistoryRow, { kind: "crypto" }>[], cryptoMinor: bigint, held: Map<string, bigint>) {
  const units = new Map<string, bigint>();
  for (const [ticker, chart] of Object.entries(input.coinCharts)) {
    const prices = [...chart.points].map(point => ({ at: Date.parse(point.at), price: scaled(point.price) })).sort((a, b) => a.at - b.at);
    const trade = tradePrices(rows.filter(row => row.ticker === ticker)).at(-1);
    if (!trade || !prices.length) continue;
    const at = Date.parse(trade.at), etp = (prices.findLast(point => point.at <= at) ?? prices[0]).price;
    units.set(ticker, divide(trade.price, etp));
  }
  const heldCoins = [...held].filter(([, coins]) => coins > TOLERANCE);
  let scale = ONE;
  if (cryptoMinor > 0n && heldCoins.length && heldCoins.every(([ticker]) => units.has(ticker))) {
    const worth = heldCoins.reduce((sum, [ticker, coins]) => {
      const latest = input.coinCharts[ticker].points.reduce((last, point) => Date.parse(point.at) >= Date.parse(last.at) ? point : last);
      return sum + multiply(multiply(coins, scaled(latest.price)), units.get(ticker)!);
    }, 0n);
    if (worth > 0n) scale = divide(cryptoMinor * CENT_SCALE, worth);
  }
  for (const [ticker] of heldCoins) if (units.has(ticker)) units.set(ticker, multiply(units.get(ticker)!, scale));
  return units;
}

function replay(input: HistoryInput): HistoryResult {
  const fail = (reason: string): HistoryResult => ({ ok: false, reason });
  const rows = [...input.rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!rows.length) return fail("Scalable returned no settled transactions");

  for (const row of rows) {
    if (row.currency && row.currency !== CURRENCY) return fail(`A transaction is in ${row.currency}, and only ${CURRENCY} is supported`);
    if (row.kind === "cash") continue;
    if (row.side !== "BUY" && row.side !== "SELL") return fail(`Transaction ${row.id} has an unknown side: ${row.side}`);
    if (row.quantity === null) return fail(`Transaction ${row.id} has no quantity`);
  }
  for (const [isin, chart] of Object.entries(input.charts)) if (chart.currency !== CURRENCY) return fail(`${isin} is priced in ${chart.currency}, and only ${CURRENCY} is supported`);
  for (const holding of input.holdings) if (holding.currency !== CURRENCY && Number(holding.filled) > 0) return fail(`${holding.isin} is priced in ${holding.currency}, and only ${CURRENCY} is supported`);

  const cryptoMinor = BigInt(toMinor(input.cryptoValue, CURRENCY));
  const heldCoins = new Map(input.coins.map(coin => [coin.ticker, scaled(coin.filled)]));
  if (cryptoMinor > 0n && ![...heldCoins.values()].some(coins => coins > TOLERANCE)) return fail("Scalable values crypto but lists no coins");

  const securityRows = rows.filter(row => row.kind === "security"), cryptoRows = rows.filter(row => row.kind === "crypto");
  const shares = new Map<string, bigint>(), prices = new Map<string, Prices>();
  for (const isin of new Set(securityRows.map(row => row.isin))) {
    shares.set(isin, 0n);
    prices.set(isin, pricesFrom(input.charts[isin], input.timeZone, tradePrices(securityRows.filter(row => row.isin === isin))));
  }
  const units = coinUnits(input, cryptoRows, cryptoMinor, heldCoins);
  const coins = new Map<string, Coin>();
  for (const ticker of new Set(cryptoRows.map(row => row.ticker)))
    coins.set(ticker, { coins: 0n, costMinor: 0n, prices: pricesFrom(input.coinCharts[ticker], input.timeZone), unit: units.get(ticker) ?? null });

  const byDay = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const day = calendarDate(row.at, input.timeZone);
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }
  const eventDays = [...byDay.keys()].sort(), first = eventDays[0], lastEvent = eventDays.at(-1)!;
  const dayBefore = new Date(Date.parse(`${input.before}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

  const days: HistoryDay[] = [];
  let cashMinor = 0n;
  for (const date of dayRange(first, lastEvent > dayBefore ? lastEvent : dayBefore)) {
    for (const row of byDay.get(date) ?? []) {
      const amount = BigInt(toMinor(row.amountText, CURRENCY));
      cashMinor += amount;
      if (row.kind === "cash") continue;
      const quantity = scaled(row.quantity!), bought = row.side === "BUY";
      if (row.kind === "security") shares.set(row.isin, shares.get(row.isin)! + (bought ? quantity : -quantity));
      else {
        const coin = coins.get(row.ticker)!;
        // Selling part of a coin takes the same part of what was paid for it.
        coin.costMinor = bought ? coin.costMinor + absolute(amount) : coin.coins > 0n ? coin.costMinor - coin.costMinor * quantity / coin.coins : coin.costMinor;
        coin.coins += bought ? quantity : -quantity;
      }
    }
    for (const [isin, held] of shares) if (held < -TOLERANCE) return fail(`Shares of ${isin} go negative on ${date}`);
    for (const [ticker, coin] of coins) if (coin.coins < -TOLERANCE) return fail(`${ticker} coins go negative on ${date}`);
    if (date > dayBefore) continue;

    let securitiesMinor = 0n, coinsMinor = 0n;
    for (const [isin, held] of shares) {
      if (held <= TOLERANCE) continue;
      const price = priceOn(prices.get(isin)!, date);
      if (price === null) return fail(`${isin} has no price on ${date}`);
      securitiesMinor += value(held, price);
    }
    for (const coin of coins.values()) {
      if (coin.coins <= TOLERANCE) continue;
      const price = priceOn(coin.prices, date);
      // Without an ETP price yet, a coin stays at what was paid for it.
      coinsMinor += price === null || coin.unit === null ? coin.costMinor : value(coin.coins, multiply(price, coin.unit));
    }
    days.push({ date, securitiesMinor, cryptoMinor: coinsMinor, cashMinor, totalMinor: securitiesMinor + coinsMinor + cashMinor });
  }

  for (const isin of new Set([...shares.keys(), ...input.holdings.map(holding => holding.isin)])) {
    const held = input.holdings.find(holding => holding.isin === isin)?.filled ?? 0, replayed = shares.get(isin) ?? 0n;
    if (absolute(replayed - scaled(held)) > TOLERANCE) return fail(`Shares of ${isin} replay to ${decimalOf(replayed)}, but Scalable holds ${text(held)}`);
  }
  for (const ticker of new Set([...coins.keys(), ...heldCoins.keys()])) {
    const held = heldCoins.get(ticker) ?? 0n, replayed = coins.get(ticker)?.coins ?? 0n;
    if (absolute(replayed - held) > TOLERANCE) return fail(`${ticker} coins replay to ${decimalOf(replayed)}, but Scalable holds ${decimalOf(held)}`);
  }
  const balance = BigInt(toMinor(input.cashBalance, CURRENCY));
  if (absolute(cashMinor - balance) > CASH_TOLERANCE) return fail(`Cash replays to ${cashMinor} cents, but Scalable holds ${balance}`);
  return { ok: true, days: days.filter(day => day.date < input.before) };
}

/** Each past day's value, or why it can't be trusted. The check runs over everything before any day is returned. */
export function calculateHistory(input: HistoryInput): HistoryResult {
  try { return replay(input); } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "The transactions could not be read" }; }
}
