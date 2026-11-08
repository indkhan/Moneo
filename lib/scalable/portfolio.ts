import { createHash } from "node:crypto";
import { z } from "zod";
import { minorDigits } from "@/lib/finance/fx";
import { holdingValue } from "@/lib/finance/wealth";

// Scalable MCP answers, validated down to the fields Moneo uses. Amounts arrive as JSON numbers.
const money = z.number().finite();
export const holdingsSchema = z.object({
  holdings: z.array(z.object({
    isin: z.string().min(1), name: z.string().min(1), fifoPrice: money.nullable().optional(), valuation: money, valuationCurrency: z.string().regex(/^[A-Z]{3}$/),
    currentQuote: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), midPrice: money }), position: z.object({ filled: money }),
  })),
  cryptoHoldings: z.array(z.object({ ticker: z.string(), name: z.string(), position: z.object({ filled: money }).nullable() })).default([]),
});
export const overviewSchema = z.object({
  valuation: z.object({ total: money, securities: money.default(0), crypto: money.default(0) }),
  timestamps: z.object({ valuationTimestampUtc: z.string() }).partial().optional(),
  performance: z.array(z.object({ timeframe: z.string(), simpleAbsoluteReturn: money.nullable() })).default([]),
});
export const cashSchema = z.object({ cash: z.object({ cashBalance: money }) });

export type ScalableSnapshot = { holdings: z.infer<typeof holdingsSchema>; overview: z.infer<typeof overviewSchema>; cash: z.infer<typeof cashSchema> };

/** Shortest exact decimal text for a JSON number (never exponent notation). */
export function decimalText(value: number) {
  const text = String(Math.abs(value));
  return text.includes("e") ? Math.abs(value).toFixed(18).replace(/\.?0+$/, "") : text;
}
const minor = (value: number, currency: string) => BigInt(Math.round(value * 10 ** minorDigits(currency)));

/** Same workspace + position key → same wealth item id, so every sync and every reconnect updates one record. */
export function scalableItemId(workspaceId: string, key: string) {
  const hex = createHash("sha256").update(`scalable:${workspaceId}:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type ScalableWealthItem = { id: string; kind: "holding" | "asset" | "debt"; name: string; currency_code: string; amount_minor: string;
  quantity_text: string | null; unit_price_text: string | null; cost_basis_minor: string | null; as_of: string; annual_rate_text?: string; monthly_payment_minor?: string };

/**
 * Wealth records for one Scalable portfolio on `asOf`: each security at quantity × live price, plus uninvested cash and
 * crypto as assets. An asset can't be negative, so negative cash is kept as zero cash plus a debt of the same size.
 * Their sum should be Scalable's own portfolio total; `differenceMinor` says if it isn't, and `unsupported` names anything
 * these records can't represent, so neither passes silently.
 */
export function scalableWealth({ holdings, overview, cash }: ScalableSnapshot, workspaceId: string, asOf: string, currency = "EUR") {
  const unsupported = holdings.holdings.flatMap(holding => [
    ...(holding.position.filled < 0 ? [`${holding.name} is a short position, which isn't counted.`] : []),
    ...(holding.position.filled > 0 && holding.currentQuote.currency !== currency ? [`${holding.name} is priced in ${holding.currentQuote.currency}, so it doesn't add up with the ${currency} total.`] : []),
  ]);
  const items: ScalableWealthItem[] = holdings.holdings.filter(holding => holding.position.filled > 0).map(holding => {
    const quantity = decimalText(holding.position.filled), price = decimalText(holding.currentQuote.midPrice), code = holding.currentQuote.currency;
    return { id: scalableItemId(workspaceId, `isin:${holding.isin}`), kind: "holding", name: Array.from(holding.name).slice(0, 120).join(""), currency_code: code,
      amount_minor: holdingValue(quantity, price, code).toString(), quantity_text: quantity, unit_price_text: price,
      cost_basis_minor: holding.fifoPrice ? minor(holding.fifoPrice * holding.position.filled, code).toString() : null, as_of: asOf };
  });
  const asset = (key: string, name: string, value: number): ScalableWealthItem => ({ id: scalableItemId(workspaceId, key), kind: "asset", name, currency_code: currency,
    amount_minor: minor(Math.max(value, 0), currency).toString(), quantity_text: null, unit_price_text: null, cost_basis_minor: null, as_of: asOf });
  const coins = holdings.cryptoHoldings.filter(coin => (coin.position?.filled ?? 0) > 0).map(coin => coin.name);
  if (overview.valuation.crypto > 0) items.push(asset("crypto", `Scalable crypto${coins.length ? ` (${coins.join(", ")})` : ""}`.slice(0, 120), overview.valuation.crypto));
  items.push(asset("cash", "Scalable cash", cash.cash.cashBalance));
  if (cash.cash.cashBalance < 0) items.push({ id: scalableItemId(workspaceId, "cash-owed"), kind: "debt", name: "Scalable cash owed", currency_code: currency, amount_minor: minor(cash.cash.cashBalance, currency).toString(),
    quantity_text: null, unit_price_text: null, cost_basis_minor: null, as_of: asOf, annual_rate_text: "0", monthly_payment_minor: "0" });
  const totalMinor = minor(overview.valuation.total, currency);
  const portfolio = {
    currency, asOf, valuedAt: overview.timestamps?.valuationTimestampUtc ?? null,
    totalMinor: totalMinor.toString(), differenceMinor: (totalMinor - items.reduce((sum, item) => sum + BigInt(item.amount_minor), 0n)).toString(), unsupported, securitiesMinor: minor(overview.valuation.securities, currency).toString(),
    cryptoMinor: minor(overview.valuation.crypto, currency).toString(), cashMinor: minor(cash.cash.cashBalance, currency).toString(),
    performance: overview.performance.flatMap(entry => entry.simpleAbsoluteReturn === null ? [] : [{ timeframe: entry.timeframe, returnMinor: minor(entry.simpleAbsoluteReturn, currency).toString() }]),
  };
  return { items, portfolio };
}
/** What the Wealth page shows beside the totals: recent trades and cash moves, and the watchlist, as of the last sync. */
export type ScalableExtras = {
  activity?: { id: string; date: string; status: string; type: string; description: string | null; shares: string | null; amountMinor: string | null; currencyCode: string }[];
  watchlist?: { isin: string; name: string; priceMinor: string | null; currencyCode: string; dayPercent: number | null }[];
  /** Every item id a sync ever wrote, so the value chart keeps positions that were sold since. */
  knownItemIds?: string[]; itemIds?: string[];
};
// A portfolio saved before these fields existed has none of them.
export type ScalablePortfolio = Omit<ReturnType<typeof scalableWealth>["portfolio"], "differenceMinor" | "unsupported"> & Partial<Pick<ReturnType<typeof scalableWealth>["portfolio"], "differenceMinor" | "unsupported">> & ScalableExtras;
