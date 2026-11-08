import { expect, it } from "vitest";
import { calculateHistory, readHistoryInput, type HistoryInput } from "./history";

const ISIN = "DE000A0TEST1", ETP = "XS0000000ETP";
const buy = (id: string, at: string, quantity: string, amount: string, isin = ISIN) => ({ id, at, kind: "security" as const, isin, side: "BUY", quantity, amountText: amount });
const sell = (id: string, at: string, quantity: string, amount: string, isin = ISIN) => ({ id, at, kind: "security" as const, isin, side: "SELL", quantity, amountText: amount });
const cash = (id: string, at: string, amount: string) => ({ id, at, kind: "cash" as const, amountText: amount });
const coin = (id: string, at: string, side: string, coins: string, amount: string, ticker = "BTC") => ({ id, at, kind: "crypto" as const, ticker, side, quantity: coins, amountText: amount });
const chart = (...points: [string, number][]) => ({ currency: "EUR", points: points.map(([at, price]) => ({ at, price: String(price) })) });

const input = (over: Partial<HistoryInput> = {}): HistoryInput => ({
  rows: [cash("d", "2026-01-01T09:00:00Z", "100"), buy("b", "2026-01-02T10:00:00Z", "2", "-20")],
  charts: { [ISIN]: chart(["2026-01-03T17:00:00Z", 11], ["2026-01-05T17:00:00Z", 12]) }, coinCharts: {},
  holdings: [{ isin: ISIN, filled: 2, currency: "EUR" }], coins: [], cashBalance: 80, cryptoValue: 0, timeZone: "UTC", before: "2026-01-06", ...over,
});
const failed = (over: Partial<HistoryInput>) => { const result = calculateHistory(input(over)); expect(result.ok).toBe(false); return result.ok ? "" : result.reason; };
const days = (over: Partial<HistoryInput> = {}) => { const result = calculateHistory(input(over)); if (!result.ok) throw new Error(result.reason); return result.days; };

it("values each day from the first transaction through the day before the first sync, using the latest price and never interpolating", () => {
  expect(days().map(day => [day.date, day.securitiesMinor, day.cashMinor, day.totalMinor])).toEqual([
    ["2026-01-01", 0n, 10000n, 10000n],
    ["2026-01-02", 2000n, 8000n, 10000n], // the trade's own price
    ["2026-01-03", 2200n, 8000n, 10200n],
    ["2026-01-04", 2200n, 8000n, 10200n], // a gap in the chart keeps the last price
    ["2026-01-05", 2400n, 8000n, 10400n],
  ]);
});

it("signs shares by side, adds exact decimals and keeps selling on the right side", () => {
  const rows = [cash("d", "2026-01-01T09:00:00Z", "100"), buy("b", "2026-01-01T10:00:00Z", "0.1", "-1"), buy("c", "2026-01-01T11:00:00Z", "0.2", "-2"), sell("s", "2026-01-02T10:00:00Z", "0.1", "1.5")];
  const result = days({ rows, holdings: [{ isin: ISIN, filled: 0.2, currency: "EUR" }], cashBalance: 98.5, charts: { [ISIN]: chart() }, before: "2026-01-03" });
  expect(result.map(day => [day.securitiesMinor, day.cashMinor])).toEqual([[300n, 9700n], [300n, 9850n]]);
});

it("uses the workspace's calendar day for transactions and prices", () => {
  // 23:30 UTC on Jan 1 is already Jan 2 in Berlin.
  const rows = [cash("d", "2026-01-01T23:30:00Z", "100"), buy("b", "2026-01-02T23:30:00Z", "2", "-20")];
  const over = { rows, charts: { [ISIN]: chart(["2026-01-03T23:30:00Z", 15]) }, before: "2026-01-05" };
  expect(days({ ...over, timeZone: "Europe/Berlin" }).map(day => [day.date, day.totalMinor])).toEqual([["2026-01-02", 10000n], ["2026-01-03", 10000n], ["2026-01-04", 11000n]]);
  expect(days({ ...over, timeZone: "UTC" }).map(day => [day.date, day.totalMinor])).toEqual([["2026-01-01", 10000n], ["2026-01-02", 10000n], ["2026-01-03", 11000n], ["2026-01-04", 11000n]]);
});

it("returns no days when the first sync is not after the first transaction, after still checking", () => {
  expect(days({ before: "2026-01-01" })).toEqual([]);
  expect(failed({ before: "2026-01-01", holdings: [{ isin: ISIN, filled: 3, currency: "EUR" }] })).toContain(ISIN);
});

it("counts transactions after the first sync in the check but shows no day from then", () => {
  const rows = [...input().rows, buy("late", "2026-01-08T10:00:00Z", "1", "-10")];
  const result = days({ rows, holdings: [{ isin: ISIN, filled: 3, currency: "EUR" }], cashBalance: 70 });
  expect(result.at(-1)!.date).toBe("2026-01-05");
  expect(result.at(-1)!.securitiesMinor).toBe(2400n);
});

it("fails the check on a share, coin or cash mismatch", () => {
  expect(failed({ holdings: [{ isin: ISIN, filled: 2.1, currency: "EUR" }] })).toContain(ISIN);
  expect(failed({ holdings: [{ isin: ISIN, filled: 2, currency: "EUR" }, { isin: "US0000000002", filled: 1, currency: "EUR" }] })).toContain("US0000000002");
  expect(failed({ cashBalance: 81.01 })).toMatch(/cash/i);
  expect(failed({ coins: [{ ticker: "BTC", filled: 0.5 }], cryptoValue: 100 })).toContain("BTC");
  expect(failed({ cryptoValue: 100 })).toMatch(/crypto/i);
});

it("tolerates tiny differences: a millionth of a share and up to a euro of cash", () => {
  expect(days({ holdings: [{ isin: ISIN, filled: 2.0000005, currency: "EUR" }] }).length).toBe(5);
  expect(days({ cashBalance: 81 }).length).toBe(5);
});

it("fails when shares or coins go negative on any day, even if they end right", () => {
  const rows = [cash("d", "2026-01-01T09:00:00Z", "100"), sell("s", "2026-01-02T10:00:00Z", "1", "10"), buy("b", "2026-01-03T10:00:00Z", "3", "-30")];
  expect(failed({ rows, charts: { [ISIN]: chart() } })).toMatch(/negative/i);
  const coins = [cash("d", "2026-01-01T09:00:00Z", "100"), coin("s", "2026-01-02T10:00:00Z", "SELL", "1", "10"), coin("b", "2026-01-03T10:00:00Z", "BUY", "1", "-10")];
  expect(failed({ rows: coins, charts: {}, holdings: [], coins: [{ ticker: "BTC", filled: 0 }], cashBalance: 100 })).toMatch(/negative/i);
  // Same-day order does not matter: only each day's end counts.
  expect(days({ rows: [cash("d", "2026-01-01T09:00:00Z", "100"), sell("s", "2026-01-02T09:00:00Z", "1", "10"), buy("b", "2026-01-02T10:00:00Z", "3", "-30")],
    charts: { [ISIN]: chart() } }).length).toBe(5);
});

it("fails when a held security has no price on a day it was held", () => {
  const rows = [cash("d", "2026-01-01T09:00:00Z", "100"), buy("b", "2026-01-02T10:00:00Z", "2", "0")];
  expect(failed({ rows, charts: { [ISIN]: chart(["2026-01-04T10:00:00Z", 1]) }, cashBalance: 100 })).toMatch(/price/i);
});

it("refuses prices in another currency instead of converting", () => {
  expect(failed({ charts: { [ISIN]: { currency: "USD", points: [] } } })).toContain("USD");
  expect(failed({ holdings: [{ isin: ISIN, filled: 2, currency: "USD" }] })).toContain("USD");
  expect(failed({ rows: [{ ...cash("d", "2026-01-01T09:00:00Z", "100"), currency: "USD" }], charts: {}, holdings: [], cashBalance: 100 })).toContain("USD");
});

it("never guesses from a settled row it cannot read", () => {
  expect(failed({ rows: [...input().rows, { id: "x", at: "2026-01-03T10:00:00Z", kind: "security", isin: ISIN, side: "TRANSFER", quantity: "1", amountText: "0" }] })).toMatch(/TRANSFER/);
  expect(failed({ rows: [...input().rows, { id: "x", at: "2026-01-03T10:00:00Z", kind: "security", isin: ISIN, side: "BUY", quantity: null, amountText: "-1" }] })).toMatch(/quantity/i);
});

it("estimates a held coin from its ETP so the last price lands on today's crypto value", () => {
  // 0.5 BTC worth 1000 today; the ETP is 10 today, so a coin is 200 ETP prices.
  const result = days({
    rows: [cash("d", "2026-01-01T09:00:00Z", "1000"), coin("b", "2026-01-02T10:00:00Z", "BUY", "0.5", "-400")],
    charts: {}, holdings: [], coins: [{ ticker: "BTC", filled: 0.5 }], cashBalance: 600, cryptoValue: 1000,
    coinCharts: { BTC: chart(["2026-01-02T17:00:00Z", 8], ["2026-01-04T17:00:00Z", 9], ["2026-01-09T17:00:00Z", 10]) },
  });
  expect(result.map(day => [day.date, day.cryptoMinor, day.cashMinor, day.totalMinor])).toEqual([
    ["2026-01-01", 0n, 100000n, 100000n],
    ["2026-01-02", 80000n, 60000n, 140000n],
    ["2026-01-03", 80000n, 60000n, 140000n],
    ["2026-01-04", 90000n, 60000n, 150000n],
    ["2026-01-05", 90000n, 60000n, 150000n],
  ]);
});

it("keeps today's crypto value when several coins are held, split by each coin's own trade", () => {
  // Trades say a BTC is 100 ETP prices and an ETH 10; at today's ETP prices that is 200 + 200, scaled to the real 500.
  const result = days({
    rows: [cash("d", "2026-01-01T09:00:00Z", "1000"), coin("b", "2026-01-02T10:00:00Z", "BUY", "1", "-100"), coin("e", "2026-01-02T11:00:00Z", "BUY", "2", "-100", "ETH")],
    charts: {}, holdings: [], coins: [{ ticker: "BTC", filled: 1 }, { ticker: "ETH", filled: 2 }], cashBalance: 800, cryptoValue: 500, before: "2026-01-04",
    coinCharts: { BTC: chart(["2026-01-02T09:00:00Z", 1], ["2026-01-03T17:00:00Z", 2]), ETH: chart(["2026-01-02T09:00:00Z", 5], ["2026-01-03T17:00:00Z", 10]) },
  });
  expect(result.at(-1)!.cryptoMinor).toBe(50000n);
});

it("scales a sold coin by its own last trade, with no held value to anchor it", () => {
  const result = days({
    rows: [cash("d", "2026-01-01T09:00:00Z", "1000"), coin("b", "2026-01-02T10:00:00Z", "BUY", "1", "-100"), coin("s", "2026-01-04T10:00:00Z", "SELL", "1", "150")],
    charts: {}, holdings: [], coins: [{ ticker: "BTC", filled: 0 }], cashBalance: 1050, cryptoValue: 0, before: "2026-01-05",
    coinCharts: { BTC: chart(["2026-01-02T09:00:00Z", 1], ["2026-01-03T17:00:00Z", 1.5]) },
  });
  expect(result.map(day => day.cryptoMinor)).toEqual([0n, 10000n, 15000n, 0n]);
  expect(result.at(-1)!.cashMinor).toBe(105000n);
});

it("keeps a coin without an ETP chart at its buy amount", () => {
  const result = days({
    rows: [cash("d", "2026-01-01T09:00:00Z", "1000"), coin("b", "2026-01-02T10:00:00Z", "BUY", "1", "-100"), coin("c", "2026-01-03T10:00:00Z", "BUY", "1", "-300"), coin("s", "2026-01-04T10:00:00Z", "SELL", "1", "500")],
    charts: {}, holdings: [], coins: [{ ticker: "BTC", filled: 1 }], cashBalance: 1100, cryptoValue: 900, before: "2026-01-05",
  });
  expect(result.map(day => day.cryptoMinor)).toEqual([0n, 10000n, 40000n, 20000n]);
});

// The stand-in below answers like the real server: an exhausted stream starts again when its cursor is left out.
function fakeMcp(pages: { securities: unknown[][]; crypto: unknown[][] }, charts: Record<string, unknown> = {}, catalog: unknown[] = []) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return { calls, callTool: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    if (name === "list_portfolio_transactions") {
      const security = Number(args.cursor ?? 0), crypto = Number(args.cryptoCursor ?? 0);
      return { page: { totalCount: 1, nextCursor: pages.securities[security + 1] ? String(security + 1) : null }, transactions: pages.securities[security] ?? [],
        crypto: { page: { nextCursor: pages.crypto[crypto + 1] ? String(crypto + 1) : "" }, transactions: pages.crypto[crypto] ?? [] } };
    }
    if (name === "get_portfolio_holdings") return { holdings: [{ isin: ISIN, position: { filled: 1 }, currentQuote: { midPrice: 10, currency: "EUR" } }], cryptoHoldings: catalog };
    if (name === "get_portfolio_cash_breakdown") return { cash: { cashBalance: 5 } };
    if (name === "get_portfolio_overview") return { valuation: { total: 15, crypto: 0 } };
    if (name === "get_security_chart") {
      const chart = charts[`${args.isin}:${args.timeframe}`] ?? charts[String(args.isin)];
      if (chart instanceof Error) throw chart;
      return chart ?? { currency: "EUR", dataPoints: [] };
    }
    throw new Error(`Unexpected tool ${name}`);
  } };
}
const security = (id: string, status = "SETTLED", extra: object = {}) => ({ id, kind: "SECURITY", status, currency: "EUR", isCancellation: false, lastEventAt: "2026-01-02T10:00:00Z", security: { isin: ISIN, transactionType: "SINGLE", side: "BUY", quantity: "1", amount: "-10" }, ...extra });
const crypto = (id: string) => ({ id, status: "SETTLED", ticker: "BTC", side: "BUY", coinQuantity: "0.5", quantity: "999", amount: "-5", lastEventAt: "2026-01-02T11:00:00Z" });

it("follows both cursors to their ends, keeps exhausted streams exhausted and removes repeated rows", async () => {
  const mcp = fakeMcp({ securities: [[security("a"), security("b")], [security("c")]], crypto: [[crypto("x")], [crypto("x"), crypto("y")], [crypto("z"), crypto("y")]] });
  const input = await readHistoryInput(mcp, "UTC", "2026-02-01");
  expect(input.rows.map(row => row.id).sort()).toEqual(["a", "b", "c", "x", "y", "z"]);
  expect(mcp.calls.filter(call => call.name === "list_portfolio_transactions").map(call => call.args)).toEqual([
    { pageSize: 100 }, { pageSize: 100, cursor: "1", cryptoCursor: "1" }, { pageSize: 100, cryptoCursor: "2" }]);
});

it("reads coins from coinQuantity, never quantity, and only settled rows that were not cancelled", async () => {
  const mcp = fakeMcp({ securities: [[security("a"), security("p", "PENDING"), security("c", "SETTLED", { isCancellation: true }),
    { id: "cash", kind: "CASH", status: "SETTLED", currency: "EUR", isCancellation: false, lastEventAt: "2026-01-01T10:00:00Z", cash: { relatedIsin: null, transactionType: "DEPOSIT", amount: 100 } },
    { id: "split", kind: "NON_TRADE", status: "SETTLED", isCancellation: false, lastEventAt: "2026-01-01T10:00:00Z", nonTradeSecurity: { isin: ISIN, quantity: "5" } }]], crypto: [[crypto("x")]] });
  const input = await readHistoryInput(mcp, "UTC", "2026-02-01");
  expect(input.rows.map(row => [row.id, row.kind, row.quantity ?? null, row.amountText])).toEqual([["a", "security", "1", "-10"], ["cash", "cash", null, "100"], ["x", "crypto", "0.5", "-5"]]);
});

it("merges every chart timeframe, skips empty prices and fails when a security chart cannot be read", async () => {
  const rows = { securities: [[security("a")]], crypto: [[]] };
  const mcp = fakeMcp(rows, {
    [`${ISIN}:max`]: { currency: "EUR", dataPoints: [{ midPrice: 8, timestampUtc: "2025-01-01T00:00:00Z" }] },
    [`${ISIN}:one_year`]: { currency: "EUR", dataPoints: [{ midPrice: "9", timestampUtc: "2025-06-01T00:00:00Z" }, { midPrice: null, timestampUtc: "2025-06-02T00:00:00Z" }, { midPrice: 0, timestampUtc: "2025-06-03T00:00:00Z" }] },
    [`${ISIN}:six_months`]: { currency: "EUR", dataPoints: [{ midPrice: 10, timestampUtc: "2025-12-01T00:00:00Z" }] },
    [`${ISIN}:year_to_date`]: { currency: "EUR", dataPoints: [{ midPrice: 11, timestampUtc: "2026-01-01T00:00:00Z" }] },
  });
  expect((await readHistoryInput(mcp, "UTC", "2026-02-01")).charts[ISIN].points.map(point => point.price).sort()).toEqual(["10", "11", "8", "9"]);
  await expect(readHistoryInput(fakeMcp(rows, { [`${ISIN}:one_year`]: new Error("down") }), "UTC", "2026-02-01")).rejects.toThrow("down");
});

it("uses the first ETP whose chart works for a coin", async () => {
  const catalog = [{ ticker: "BTC", name: "Bitcoin", position: { filled: 0.5 }, etpPositions: [{ isin: "XS0000000BAD", name: "Bad", position: null }, { isin: "XS0000000USD", name: "Usd", position: null }, { isin: ETP, name: "Good", position: null }, { isin: "XS000000LAST", name: "Unused", position: null }] },
    { ticker: "ETH", name: "Ether", position: { filled: 0 }, etpPositions: [{ isin: "XS0000000ETH", name: "Not traded", position: null }] }];
  const mcp = fakeMcp({ securities: [[]], crypto: [[crypto("x")]] }, { XS0000000BAD: new Error("no chart"), XS0000000USD: { currency: "USD", dataPoints: [{ midPrice: 1, timestampUtc: "2026-01-01T00:00:00Z" }] },
    [ETP]: { currency: "EUR", dataPoints: [{ midPrice: 1, timestampUtc: "2026-01-01T00:00:00Z" }] } }, catalog);
  const input = await readHistoryInput(mcp, "UTC", "2026-02-01");
  expect(input.coinCharts.BTC.points.length).toBeGreaterThan(0);
  expect(input.coinCharts.ETH).toBeUndefined();
  const charted = mcp.calls.filter(call => call.name === "get_security_chart").map(call => call.args.isin);
  expect(charted).not.toContain("XS000000LAST");
  expect(charted).not.toContain("XS0000000ETH");
});

it("only ever calls read tools", async () => {
  const catalog = [{ ticker: "BTC", name: "Bitcoin", position: { filled: 0.5 }, etpPositions: [{ isin: ETP, name: "Good", position: null }] }];
  const mcp = fakeMcp({ securities: [[security("a")]], crypto: [[crypto("x")]] }, {}, catalog);
  await readHistoryInput(mcp, "UTC", "2026-02-01");
  expect([...new Set(mcp.calls.map(call => call.name))].sort()).toEqual(["get_portfolio_cash_breakdown", "get_portfolio_holdings", "get_portfolio_overview", "get_security_chart", "list_portfolio_transactions"]);
});
