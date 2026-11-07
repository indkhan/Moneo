import { z } from "zod";
import { serviceDb } from "@/lib/bank/server";
import { minorDigits } from "@/lib/finance/fx";
import type { ScalableMcp } from "./client";
import { scalableConfigured } from "./server";

// Live, read-only Scalable answers for chat and calls, trimmed to what a question needs. Amounts are exact
// minor units with their currency (chat adds the formatted text); Scalable's own figures are never recomputed.

export const READ_ONLY_TRADING = "Your Scalable connection only allows read access, so Moneo can't buy or sell for you. To trade from Moneo, turn on full access for AI agents in the Scalable app under Profile → Security.";

/** The workspace's active Scalable connection, or null when there is none (or this install cannot hold one). */
export async function activeScalableConnection(workspaceId: string): Promise<string | null> {
  if (!scalableConfigured()) return null;
  const { data, error } = await serviceDb().from("scalable_connections").select("id").eq("workspace_id", workspaceId).eq("status", "active")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id ?? null;
}

/** Full access lists the order tools; read-only access does not. */
export async function tradingAccess(mcp: Pick<ScalableMcp, "listTools">): Promise<"full" | "read"> {
  const names = new Set((await mcp.listTools()).map(tool => tool.name));
  return ["preview_buy_order", "preview_sell_order", "submit_buy_order", "submit_sell_order"].every(name => names.has(name)) ? "full" : "read";
}

const decimal = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/)]);
const code = z.string().regex(/^[A-Z]{3}$/);
/** A Scalable decimal (number or string) in exact minor units, rounded half away from zero. */
export function toMinor(value: number | string, currency: string): string {
  const text = typeof value === "number" ? value.toFixed(12) : value;
  const negative = text.startsWith("-"), [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const digits = minorDigits(currency), padded = fraction.padEnd(digits + 1, "0");
  let minor = BigInt(whole + padded.slice(0, digits));
  if (Number(padded[digits]) >= 5) minor += 1n;
  return (negative && minor !== 0n ? -minor : minor).toString();
}
/** Gain over cost in percent with two decimals, or null without a cost. */
const percent = (gain: bigint, cost: bigint) => cost > 0n ? Number(gain * 10000n / cost) / 100 : null;

const holdingsSchema = z.object({
  holdings: z.array(z.object({ isin: z.string(), name: z.string(), fifoPrice: decimal.nullable().optional(), valuation: decimal, valuationCurrency: code,
    currentQuote: z.object({ midPrice: decimal, currency: code, timestamp: z.string().optional() }), position: z.object({ filled: decimal, pending: decimal.optional() }) })).default([]),
  cryptoHoldings: z.array(z.object({ ticker: z.string(), name: z.string(), position: z.object({ filled: decimal }).nullable().optional() })).default([]),
});
const overviewSchema = z.object({
  valuation: z.object({ total: decimal, securities: decimal.default(0), crypto: decimal.default(0) }),
  timestamps: z.object({ valuationTimestampUtc: z.string() }).partial().optional(),
  performance: z.array(z.object({ timeframe: z.string(), simpleAbsoluteReturn: decimal.nullable() })).default([]),
});
const cashSchema = z.object({ cash: z.object({ cashBalance: decimal, buyingPower: decimal.optional(), pendingBuyOrdersAmount: decimal.optional() }) });

/** Labels for Scalable's return periods, shortest first. */
export const PERIODS: Record<string, string> = { INTRADAY: "Today", ONE_WEEK: "1 week", ONE_MONTH: "1 month", THREE_MONTHS: "3 months", SIX_MONTHS: "6 months",
  YEAR_TO_DATE: "This year", ONE_YEAR: "1 year", MAX: "All time" };

/** Holdings, gains, cash and Scalable's returns per period, read live. */
export async function investmentsPortfolio(mcp: ScalableMcp, currency = "EUR") {
  const [holdings, overview, cash, access] = await Promise.all([mcp.callTool("get_portfolio_holdings").then(value => holdingsSchema.parse(value)),
    mcp.callTool("get_portfolio_overview", { includeYearToDate: true }).then(value => overviewSchema.parse(value)),
    mcp.callTool("get_portfolio_cash_breakdown").then(value => cashSchema.parse(value)), tradingAccess(mcp)]);
  const positions = holdings.holdings.filter(holding => Number(holding.position.filled) > 0).map(holding => {
    const shares = Number(holding.position.filled), valueMinor = BigInt(toMinor(holding.valuation, holding.valuationCurrency));
    const costMinor = holding.fifoPrice ? BigInt(toMinor(Number(holding.fifoPrice) * shares, holding.valuationCurrency)) : null;
    return { isin: holding.isin, name: holding.name, shares: String(holding.position.filled), currencyCode: holding.valuationCurrency,
      priceMinor: toMinor(holding.currentQuote.midPrice, holding.currentQuote.currency), valueMinor: valueMinor.toString(),
      costMinor: costMinor?.toString() ?? null, gainMinor: costMinor === null ? null : (valueMinor - costMinor).toString(),
      gainPercent: costMinor === null ? null : percent(valueMinor - costMinor, costMinor) };
  }).sort((a, b) => Number(BigInt(b.valueMinor) - BigInt(a.valueMinor)));
  return {
    valuedAt: overview.timestamps?.valuationTimestampUtc ?? null, currencyCode: currency, tradingAccess: access,
    totalMinor: toMinor(overview.valuation.total, currency), securitiesMinor: toMinor(overview.valuation.securities, currency),
    cryptoMinor: toMinor(overview.valuation.crypto, currency), cashMinor: toMinor(cash.cash.cashBalance, currency),
    buyingPowerMinor: toMinor(cash.cash.buyingPower ?? cash.cash.cashBalance, currency), pendingBuyOrdersMinor: toMinor(cash.cash.pendingBuyOrdersAmount ?? 0, currency),
    returns: Object.keys(PERIODS).flatMap(timeframe => { const entry = overview.performance.find(item => item.timeframe === timeframe);
      return entry && entry.simpleAbsoluteReturn !== null ? [{ period: PERIODS[timeframe], returnMinor: toMinor(entry.simpleAbsoluteReturn, currency) }] : []; }),
    positions,
    crypto: holdings.cryptoHoldings.filter(coin => Number(coin.position?.filled ?? 0) > 0).map(coin => ({ name: coin.name, ticker: coin.ticker, quantity: String(coin.position!.filled) })),
  };
}

const transactionsSchema = z.object({ transactions: z.array(z.object({
  id: z.string(), kind: z.string(), status: z.string(), currency: code.optional(), lastEventAt: z.string(), description: z.string().nullable().optional(),
  security: z.object({ isin: z.string(), transactionType: z.string().nullable().optional(), quantity: decimal.nullable().optional(), amount: decimal.nullable().optional(),
    side: z.string().nullable().optional(), limitPrice: decimal.nullable().optional() }).nullable().optional(),
  cash: z.object({ transactionType: z.string().nullable().optional(), amount: decimal.nullable().optional() }).nullable().optional(),
  nonTradeSecurity: z.object({ isin: z.string().nullable().optional(), transactionType: z.string().nullable().optional(), amount: decimal.nullable().optional() }).passthrough().nullable().optional(),
})).default([]), page: z.object({ nextCursor: z.string().nullable().optional(), totalCount: z.number().optional() }).optional() });

export const transactionsInput = z.object({
  from: z.iso.date().optional().describe("First day, inclusive"), to: z.iso.date().optional().describe("Last day, inclusive"),
  isin: z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/).optional(), search: z.string().trim().min(1).max(100).optional(),
  types: z.array(z.string().max(40)).max(5).optional().describe("e.g. buy, sell, deposit, withdrawal, dividend"),
  statuses: z.array(z.string().max(40)).max(5).optional().describe("e.g. pending for open orders, settled, cancelled"),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();

export type InvestmentTransaction = ReturnType<typeof readTransactions>[number];
export function readTransactions(value: unknown) {
  return transactionsSchema.parse(value).transactions.map(row => {
    const currency = row.currency ?? "EUR", amount = row.security?.amount ?? row.cash?.amount ?? row.nonTradeSecurity?.amount ?? null;
    return { id: row.id, date: row.lastEventAt.slice(0, 10), status: row.status, description: row.description ?? null,
      type: (row.security?.side ?? row.security?.transactionType ?? row.cash?.transactionType ?? row.nonTradeSecurity?.transactionType ?? row.kind).toString().toLowerCase(),
      isin: row.security?.isin ?? row.nonTradeSecurity?.isin ?? null, shares: row.security?.quantity == null ? null : String(row.security.quantity),
      limitPriceMinor: row.security?.limitPrice == null ? null : toMinor(row.security.limitPrice, currency),
      currencyCode: currency, amountMinor: amount === null ? null : toMinor(amount, currency) };
  });
}

/** Buys, sells, deposits, withdrawals and dividends, newest first; `id` is what an order cancellation needs. */
export async function investmentsTransactions(mcp: ScalableMcp, input: z.infer<typeof transactionsInput>) {
  const raw = await mcp.callTool("list_portfolio_transactions", { pageSize: input.limit ?? 20,
    ...(input.from ? { fromTime: `${input.from}T00:00:00.000Z` } : {}), ...(input.to ? { toTime: `${input.to}T23:59:59.999Z` } : {}),
    ...(input.isin ? { isin: input.isin } : {}), ...(input.search ? { searchTerm: input.search } : {}),
    ...(input.types ? { transactionTypes: input.types } : {}), ...(input.statuses ? { statuses: input.statuses } : {}) });
  const page = transactionsSchema.parse(raw).page;
  return { transactions: readTransactions(raw), more: Boolean(page?.nextCursor) };
}

export const securityInput = z.object({
  action: z.enum(["search", "quote", "chart", "news"]),
  query: z.string().trim().min(1).max(100).optional().describe("search: a name, ticker or ISIN"),
  isin: z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/).optional().describe("quote, chart and news"),
  timeframe: z.enum(["one_day", "seven_days", "one_month", "three_months", "six_months", "year_to_date", "one_year", "max"]).optional().describe("chart only; default one_month"),
}).strict();

const quoteSchema = z.object({ midPrice: decimal, currency: code, timestampUtc: z.string().optional(), isOutdated: z.boolean().optional() }).passthrough();
const searchSchema = z.object({ results: z.array(z.object({ isin: z.string(), name: z.string(), securityType: z.string().optional(), currentQuote: quoteSchema.nullable().optional() })).default([]) });
const chartSchema = z.object({ currency: code, dataPoints: z.array(z.object({ midPrice: decimal, timestampUtc: z.string() })).default([]) });
const newsSchema = z.object({ summary: z.object({ short: z.string().optional(), long: z.string().optional() }).nullable().optional() });
const quoteResultSchema = z.object({ security: z.object({ isin: z.string(), name: z.string().optional(), securityType: z.string().optional(),
  quote: quoteSchema.and(z.object({ performances: z.array(z.object({ timeframe: z.string(), performance: decimal.nullable().optional() })).optional() })) }) });
const quoted = (quote: z.infer<typeof quoteSchema> | null | undefined) => quote ? { priceMinor: toMinor(quote.midPrice, quote.currency), currencyCode: quote.currency, at: quote.timestampUtc ?? null, outdated: quote.isOutdated ?? false } : null;

/** Any security on Scalable: search by name, its live quote, its price chart (summarised) or its news. */
export async function investmentsSecurity(mcp: ScalableMcp, input: z.infer<typeof securityInput>) {
  if (input.action === "search") {
    if (!input.query) throw new Error("Search needs a query");
    const found = searchSchema.parse(await mcp.callTool("search_securities", { query: input.query }));
    return { results: found.results.slice(0, 10).map(item => ({ isin: item.isin, name: item.name, type: item.securityType ?? null, quote: quoted(item.currentQuote) })) };
  }
  if (!input.isin) throw new Error(`${input.action} needs an ISIN; search first`);
  if (input.action === "quote") {
    const { security } = quoteResultSchema.parse(await mcp.callTool("get_security_quote", { isin: input.isin }));
    return { isin: security.isin, name: security.name ?? null, type: security.securityType ?? null, quote: quoted(security.quote),
      // Scalable's own moves for the security, as percentages.
      moves: (security.quote.performances ?? []).flatMap(entry => PERIODS[entry.timeframe] && entry.performance != null ? [{ period: PERIODS[entry.timeframe], percent: Math.round(Number(entry.performance) * 10000) / 100 }] : []) };
  }
  if (input.action === "chart") {
    const timeframe = input.timeframe ?? "one_month";
    const chart = chartSchema.parse(await mcp.callTool("get_security_chart", { isin: input.isin, timeframe }));
    const prices = chart.dataPoints.map(point => Number(point.midPrice));
    if (!prices.length) return { isin: input.isin, timeframe, points: [] };
    const first = prices[0], last = prices.at(-1)!;
    // About 24 evenly spaced points are enough to describe or draw the trend.
    const step = Math.max(1, Math.ceil(chart.dataPoints.length / 24));
    return { isin: input.isin, timeframe, currencyCode: chart.currency, firstMinor: toMinor(first, chart.currency), lastMinor: toMinor(last, chart.currency),
      lowMinor: toMinor(Math.min(...prices), chart.currency), highMinor: toMinor(Math.max(...prices), chart.currency), changePercent: Math.round((last - first) / first * 10000) / 100,
      points: chart.dataPoints.filter((_, index) => index % step === 0 || index === chart.dataPoints.length - 1).map(point => ({ at: point.timestampUtc, priceMinor: toMinor(point.midPrice, chart.currency) })) };
  }
  const news = newsSchema.parse(await mcp.callTool("get_security_news", { isin: input.isin, locale: "en_US" }));
  // Third-party text: the system prompt tells the model never to follow instructions in tool results.
  return { isin: input.isin, summary: news.summary?.short ?? null, detail: news.summary?.long?.slice(0, 2500) ?? null };
}

const watchlistSchema = z.object({ items: z.array(z.object({ isin: z.string(), name: z.string(), securityType: z.string().optional(), currentQuote: quoteSchema.nullable().optional() })).default([]) });
export async function investmentsWatchlist(mcp: ScalableMcp) {
  return { items: watchlistSchema.parse(await mcp.callTool("list_watchlist_items")).items.map(item => ({ isin: item.isin, name: item.name, type: item.securityType ?? null, quote: quoted(item.currentQuote) })) };
}
