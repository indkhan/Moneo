import { describe, expect, it } from "vitest";
import { cashSchema, decimalText, holdingsSchema, overviewSchema, scalableItemId, scalableWealth } from "./portfolio";

// Shapes as the Scalable MCP returns them (values made up).
const snapshot = {
  holdings: holdingsSchema.parse({ holdings: [
    { isin: "DE000A2QP398", name: "Tech ETF", fifoPrice: 7.88, valuation: 22.34, valuationCurrency: "EUR", currentQuote: { currency: "EUR", midPrice: 7.446 }, position: { filled: 3, blocked: 0 } },
    { isin: "IE00B3WJKG14", name: "IT ETF", fifoPrice: 44.51, valuation: 82.72, valuationCurrency: "EUR", currentQuote: { currency: "EUR", midPrice: 41.3575 }, position: { filled: 2 } },
    { isin: "US0000000000", name: "Sold out", fifoPrice: null, valuation: 0, valuationCurrency: "EUR", currentQuote: { currency: "EUR", midPrice: 10 }, position: { filled: 0 } },
  ], cryptoHoldings: [{ ticker: "BTC", name: "Bitcoin", position: { filled: 0.00328561727 } }, { ticker: "LTC", name: "Litecoin", position: { filled: 0 } }] }),
  overview: overviewSchema.parse({ valuation: { total: 336.38, securities: 105.06, crypto: 200 }, performance: [{ timeframe: "ONE_MONTH", simpleAbsoluteReturn: -10.924 }] }),
  cash: cashSchema.parse({ cash: { cashBalance: 31.32, buyingPower: 31.32 } }),
};

describe("scalableWealth", () => {
  const { items, portfolio } = scalableWealth(snapshot, "ws-1", "2026-11-05");

  it("values each held security at quantity times live price, with cost basis", () => {
    const holdings = items.filter(item => item.kind === "holding");
    expect(holdings.map(item => [item.name, item.quantity_text, item.unit_price_text, item.amount_minor, item.cost_basis_minor])).toEqual([
      ["Tech ETF", "3", "7.446", "2234", "2364"], ["IT ETF", "2", "41.3575", "8272", "8902"],
    ]);
  });

  it("adds cash and crypto so the records sum to Scalable's total", () => {
    expect(items.find(item => item.name.startsWith("Scalable crypto"))).toMatchObject({ name: "Scalable crypto (Bitcoin)", amount_minor: "20000" });
    expect(items.find(item => item.name === "Scalable cash")).toMatchObject({ kind: "asset", amount_minor: "3132" });
    expect(items.reduce((sum, item) => sum + BigInt(item.amount_minor), 0n).toString()).toBe(portfolio.totalMinor);
    expect(portfolio.differenceMinor).toBe("0");
    expect(portfolio.performance).toEqual([{ timeframe: "ONE_MONTH", returnMinor: "-1092" }]);
  });

  it("keeps negative cash signed: zero cash plus a debt, still adding up to Scalable's total", () => {
    const overdrawn = { ...snapshot, overview: overviewSchema.parse({ valuation: { total: 300.06, securities: 105.06, crypto: 200 } }), cash: cashSchema.parse({ cash: { cashBalance: -5 } }) };
    const result = scalableWealth(overdrawn, "ws-1", "2026-11-05");
    expect(result.items.find(item => item.name === "Scalable cash")).toMatchObject({ kind: "asset", amount_minor: "0" });
    expect(result.items.find(item => item.kind === "debt")).toMatchObject({ name: "Scalable cash owed", amount_minor: "-500", annual_rate_text: "0", monthly_payment_minor: "0" });
    expect(result.portfolio).toMatchObject({ cashMinor: "-500", differenceMinor: "0", unsupported: [] });
  });

  it("reports parts that miss the total and positions it can't represent", () => {
    const result = scalableWealth({ ...snapshot, overview: overviewSchema.parse({ valuation: { total: 500, securities: 105.06, crypto: 200 } }),
      holdings: holdingsSchema.parse({ holdings: [...snapshot.holdings.holdings, { isin: "US1", name: "Short", valuation: -1, valuationCurrency: "EUR", currentQuote: { currency: "EUR", midPrice: 1 }, position: { filled: -1 } }, { isin: "US2", name: "Dollar", valuation: 1, valuationCurrency: "EUR", currentQuote: { currency: "USD", midPrice: 1 }, position: { filled: 1 } }], cryptoHoldings: [] }) }, "ws-1", "2026-11-05");
    expect(result.portfolio.differenceMinor).not.toBe("0");
    expect(result.portfolio.unsupported).toEqual(["Short is a short position, which isn't counted.", "Dollar is priced in USD, so it doesn't add up with the EUR total."]);
  });

  it("keeps ids stable per workspace and position", () => {
    expect(items[0].id).toBe(scalableItemId("ws-1", "isin:DE000A2QP398"));
    expect(items[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(scalableItemId("ws-2", "isin:DE000A2QP398")).not.toBe(items[0].id);
  });
});

it("writes small numbers without exponents", () => {
  expect(decimalText(0.0000001)).toBe("0.0000001");
  expect(decimalText(41.3575)).toBe("41.3575");
});
