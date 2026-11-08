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
  // Scalable holds crypto as shares of an ETP, so `isin` and `quantity` are the ETP's.
  | { kind: "crypto"; isin: string; side: string; quantity: string | null; amountText: string });
export type HistoryInput = {
  rows: HistoryRow[]; charts: Record<string, Chart>;
  holdings: { isin: string; filled: number | string; currency?: string }[];
  cashBalance: number | string; timeZone: string;
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
    side: z.string().nullish(), quantity: decimal.nullish(), amount: decimal.nullish() })).default([]) }).nullish(),
});
const holdingsSchema = z.object({
  holdings: z.array(z.object({ isin: z.string(), position: z.object({ filled: decimal }), currentQuote: z.object({ currency: z.string() }) })).default([]),
  cryptoHoldings: z.array(z.object({ ticker: z.string(), position: z.object({ filled: decimal }).nullish(), etpPositions: z.array(z.object({ isin: z.string(), position: z.object({ filled: decimal }).nullish() })).nullish() })).default([]),
});
const chartSchema = z.object({ currency: z.string().nullish(), dataPoints: z.array(z.object({ midPrice: decimal.nullish(), timestampUtc: z.string() })).default([]) });
const detailsSchema = z.object({ transaction: z.object({ security: z.object({ isin: z.string() }) }) });
const settled = (row: { status: string; isCancellation?: boolean | null }) => row.status === "SETTLED" && !row.isCancellation;

/** Every settled trade and cash move. Security and crypto rows page separately, and a stream whose cursor runs out starts over if asked again. */
async function readRows(mcp: Pick<ScalableMcp, "callTool">) {
  const securities = new Map<string, HistoryRow>(), crypto = new Map<string, Omit<Extract<HistoryRow, { kind: "crypto" }>, "isin">>();
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
      crypto.set(row.id, { id: row.id, at: row.lastEventAt, kind: "crypto", side: row.side ?? "unknown", quantity: row.quantity == null ? null : text(row.quantity), amountText: String(row.amount ?? 0) });
    cursor = securitiesDone ? undefined : reply.page?.nextCursor || undefined;
    cryptoCursor = cryptoDone ? undefined : reply.crypto?.page?.nextCursor || undefined;
    securitiesDone = !cursor; cryptoDone = !cryptoCursor;
  }
  // A crypto row only names the coin; its details name the ETP that was actually bought.
  const rows = [...securities.values()];
  for (const row of crypto.values()) rows.push({ ...row, isin: detailsSchema.parse(await mcp.callTool("get_transaction_details", { transactionId: row.id })).transaction.security.isin });
  return rows;
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
  // Scalable's coin figure shrinks over time, while the ETP's shares and price are exact, so those are what count.
  const unbacked = holdings.cryptoHoldings.find(coin => Number(coin.position?.filled ?? 0) > 0 && !coin.etpPositions?.some(etp => Number(etp.position?.filled ?? 0) > 0));
  if (unbacked) throw new Error(`${unbacked.ticker} is held without an ETP position`);
  const charts: Record<string, Chart> = {};
  for (const isin of new Set(rows.flatMap(row => row.kind === "cash" ? [] : [row.isin]))) charts[isin] = await readChart(mcp, isin);
  return { rows, charts, timeZone, before, cashBalance: cash.cash.cashBalance,
    holdings: [...holdings.holdings.map(holding => ({ isin: holding.isin, filled: holding.position.filled, currency: holding.currentQuote.currency })),
      ...holdings.cryptoHoldings.flatMap(coin => (coin.etpPositions ?? []).flatMap(etp => etp.position ? [{ isin: etp.isin, filled: etp.position.filled }] : []))] };
}

// Shares and prices are fixed-point bigints with 18 decimals, so nothing drifts the way floats do.
const ONE = 10n ** 18n, TOLERANCE = 10n ** 12n /* a millionth of a share */, CASH_TOLERANCE = 100n /* one euro */;
const CENTS = 100n, CENT_SCALE = ONE / CENTS;
const scaled = (value: number | string) => { const ratio = decimalRatio(text(value)); return ratio.numerator * ONE / ratio.denominator; };
const decimalOf = (value: bigint) => `${value / ONE}.${(value % ONE).toString().padStart(18, "0")}`;
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
  for (const holding of input.holdings) if (holding.currency && holding.currency !== CURRENCY && Number(holding.filled) > 0) return fail(`${holding.isin} is priced in ${holding.currency}, and only ${CURRENCY} is supported`);

  const trades = rows.filter(row => row.kind !== "cash");
  const cryptoIsins = new Set(trades.filter(row => row.kind === "crypto").map(row => row.isin));
  const shares = new Map<string, bigint>(), prices = new Map<string, Prices>();
  for (const isin of new Set(trades.map(row => row.isin))) {
    shares.set(isin, 0n);
    prices.set(isin, pricesFrom(input.charts[isin], input.timeZone, tradePrices(trades.filter(row => row.isin === isin))));
  }

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
      const quantity = scaled(row.quantity!);
      shares.set(row.isin, shares.get(row.isin)! + (row.side === "BUY" ? quantity : -quantity));
    }
    for (const [isin, held] of shares) if (held < -TOLERANCE) return fail(`Shares of ${isin} go negative on ${date}`);
    if (date > dayBefore) continue;

    let securitiesMinor = 0n, cryptoMinor = 0n;
    for (const [isin, held] of shares) {
      if (held <= TOLERANCE) continue;
      const price = priceOn(prices.get(isin)!, date);
      if (price === null) return fail(`${isin} has no price on ${date}`);
      if (cryptoIsins.has(isin)) cryptoMinor += value(held, price);
      else securitiesMinor += value(held, price);
    }
    days.push({ date, securitiesMinor, cryptoMinor, cashMinor, totalMinor: securitiesMinor + cryptoMinor + cashMinor });
  }

  for (const isin of new Set([...shares.keys(), ...input.holdings.map(holding => holding.isin)])) {
    const held = input.holdings.find(holding => holding.isin === isin)?.filled ?? 0, replayed = shares.get(isin) ?? 0n;
    if (absolute(replayed - scaled(held)) > TOLERANCE) return fail(`Shares of ${isin} replay to ${decimalOf(replayed)}, but Scalable holds ${text(held)}`);
  }
  const balance = BigInt(toMinor(input.cashBalance, CURRENCY));
  if (absolute(cashMinor - balance) > CASH_TOLERANCE) return fail(`Cash replays to ${cashMinor} cents, but Scalable holds ${balance}`);
  return { ok: true, days: days.filter(day => day.date < input.before) };
}

/** Each past day's value, or why it can't be trusted. The check runs over everything before any day is returned. */
export function calculateHistory(input: HistoryInput): HistoryResult {
  try { return replay(input); } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "The transactions could not be read" }; }
}
