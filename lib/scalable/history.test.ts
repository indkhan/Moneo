import { expect, it } from "vitest";
import { calculateHistory, readHistoryInput, type HistoryInput } from "./history";

const ISIN = "DE000A0TEST1", ETP = "XS0000000ETP";
const buy = (id: string, at: string, quantity: string, amount: string, isin = ISIN) => ({ id, at, kind: "security" as const, isin, side: "BUY", quantity, amountText: amount });
const sell = (id: string, at: string, quantity: string, amount: string, isin = ISIN) => ({ id, at, kind: "security" as const, isin, side: "SELL", quantity, amountText: amount });
const cash = (id: string, at: string, amount: string) => ({ id, at, kind: "cash" as const, amountText: amount });
const etp = (id: string, at: string, side: string, shares: string, amount: string) => ({ id, at, kind: "crypto" as const, isin: ETP, side, quantity: shares, amountText: amount });
const chart = (...points: [string, number][]) => ({ currency: "EUR", points: points.map(([at, price]) => ({ at, price: String(price) })) });

const input = (over: Partial<HistoryInput> = {}): HistoryInput => ({
  rows: [cash("d", "2026-01-01T09:00:00Z", "100"), buy("b", "2026-01-02T10:00:00Z", "2", "-20")],
  charts: { [ISIN]: chart(["2026-01-03T17:00:00Z", 11], ["2026-01-05T17:00:00Z", 12]) },
  holdings: [{ isin: ISIN, filled: 2, currency: "EUR" }], cashBalance: 80, timeZone: "UTC", before: "2026-01-06", ...over,
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

it("fails the check on a share or cash mismatch", () => {
  expect(failed({ holdings: [{ isin: ISIN, filled: 2.1, currency: "EUR" }] })).toContain(ISIN);
  expect(failed({ holdings: [{ isin: ISIN, filled: 2, currency: "EUR" }, { isin: "US0000000002", filled: 1, currency: "EUR" }] })).toContain("US0000000002");
  expect(failed({ cashBalance: 81.01 })).toMatch(/cash/i);
  expect(failed({ holdings: [{ isin: ISIN, filled: 2, currency: "EUR" }, { isin: ETP, filled: 10 }] })).toContain(ETP);
});

it("tolerates tiny differences: a millionth of a share and up to a euro of cash", () => {
  expect(days({ holdings: [{ isin: ISIN, filled: 2.0000005, currency: "EUR" }] }).length).toBe(5);
  expect(days({ cashBalance: 81 }).length).toBe(5);
});

it("fails when shares go negative on any day, even if they end right", () => {
  const rows = [cash("d", "2026-01-01T09:00:00Z", "100"), sell("s", "2026-01-02T10:00:00Z", "1", "10"), buy("b", "2026-01-03T10:00:00Z", "3", "-30")];
  expect(failed({ rows, charts: { [ISIN]: chart() } })).toMatch(/negative/i);
  const crypto = [cash("d", "2026-01-01T09:00:00Z", "100"), etp("s", "2026-01-02T10:00:00Z", "SELL", "1", "10"), etp("b", "2026-01-03T10:00:00Z", "BUY", "1", "-10")];
  expect(failed({ rows: crypto, charts: {}, holdings: [], cashBalance: 100 })).toMatch(/negative/i);
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

it("values crypto as its ETP's shares at the ETP's own price, counted apart from securities", () => {
  const result = days({
    rows: [cash("d", "2026-01-01T09:00:00Z", "1000"), etp("b", "2026-01-02T10:00:00Z", "BUY", "10", "-400")],
    charts: { [ETP]: chart(["2026-01-03T17:00:00Z", 45], ["2026-01-05T17:00:00Z", 50]) }, holdings: [{ isin: ETP, filled: 10 }], cashBalance: 600,
  });
  expect(result.map(day => [day.date, day.securitiesMinor, day.cryptoMinor, day.cashMinor, day.totalMinor])).toEqual([
    ["2026-01-01", 0n, 0n, 100000n, 100000n],
    ["2026-01-02", 0n, 40000n, 60000n, 100000n], // the trade's own price
    ["2026-01-03", 0n, 45000n, 60000n, 105000n],
    ["2026-01-04", 0n, 45000n, 60000n, 105000n],
    ["2026-01-05", 0n, 50000n, 60000n, 110000n],
  ]);
});

it("stops counting an ETP that was sold", () => {
  const result = days({
    rows: [cash("d", "2026-01-01T09:00:00Z", "1000"), etp("b", "2026-01-02T10:00:00Z", "BUY", "10", "-400"), etp("s", "2026-01-04T10:00:00Z", "SELL", "10", "500")],
    charts: { [ETP]: chart() }, holdings: [], cashBalance: 1100, before: "2026-01-05",
  });
  expect(result.map(day => [day.cryptoMinor, day.cashMinor])).toEqual([[0n, 100000n], [40000n, 60000n], [40000n, 60000n], [0n, 110000n]]);
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
    if (name === "get_transaction_details") return { transaction: { security: { isin: ETP } } };
    if (name === "get_security_chart") {
      const chart = charts[`${args.isin}:${args.timeframe}`] ?? charts[String(args.isin)];
      if (chart instanceof Error) throw chart;
      return chart ?? { currency: "EUR", dataPoints: [] };
    }
    throw new Error(`Unexpected tool ${name}`);
  } };
}
const security = (id: string, status = "SETTLED", extra: object = {}) => ({ id, kind: "SECURITY", status, currency: "EUR", isCancellation: false, lastEventAt: "2026-01-02T10:00:00Z", security: { isin: ISIN, transactionType: "SINGLE", side: "BUY", quantity: "1", amount: "-10" }, ...extra });
const crypto = (id: string) => ({ id, status: "SETTLED", ticker: "BTC", side: "BUY", coinQuantity: "0.5", quantity: "10", amount: "-5", lastEventAt: "2026-01-02T11:00:00Z" });

it("follows both cursors to their ends, keeps exhausted streams exhausted and removes repeated rows", async () => {
  const mcp = fakeMcp({ securities: [[security("a"), security("b")], [security("c")]], crypto: [[crypto("x")], [crypto("x"), crypto("y")], [crypto("z"), crypto("y")]] });
  const input = await readHistoryInput(mcp, "UTC", "2026-02-01");
  expect(input.rows.map(row => row.id).sort()).toEqual(["a", "b", "c", "x", "y", "z"]);
  expect(mcp.calls.filter(call => call.name === "list_portfolio_transactions").map(call => call.args)).toEqual([
    { pageSize: 100 }, { pageSize: 100, cursor: "1", cryptoCursor: "1" }, { pageSize: 100, cryptoCursor: "2" }]);
});

it("reads a crypto row's ETP shares, never its coin figure, and only settled rows that were not cancelled", async () => {
  const mcp = fakeMcp({ securities: [[security("a"), security("p", "PENDING"), security("c", "SETTLED", { isCancellation: true }),
    { id: "cash", kind: "CASH", status: "SETTLED", currency: "EUR", isCancellation: false, lastEventAt: "2026-01-01T10:00:00Z", cash: { relatedIsin: null, transactionType: "DEPOSIT", amount: 100 } },
    { id: "split", kind: "NON_TRADE", status: "SETTLED", isCancellation: false, lastEventAt: "2026-01-01T10:00:00Z", nonTradeSecurity: { isin: ISIN, quantity: "5" } }]], crypto: [[crypto("x")]] });
  const input = await readHistoryInput(mcp, "UTC", "2026-02-01");
  expect(input.rows.map(row => [row.id, row.kind, row.quantity ?? null, row.amountText])).toEqual([["a", "security", "1", "-10"], ["cash", "cash", null, "100"], ["x", "crypto", "10", "-5"]]);
  expect(input.rows.find(row => row.id === "x")).toMatchObject({ isin: ETP });
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

it("holds crypto as ETP shares even when the coin figure has shrunk", async () => {
  const catalog = [{ ticker: "BTC", name: "Bitcoin", position: { filled: 0.00328548315 }, etpPositions: [{ isin: "XS0000000BAD", name: "Other", position: null }, { isin: ETP, name: "Held", position: { blocked: 0, filled: 10, pending: 0 } }] },
    { ticker: "ETH", name: "Ether", position: { filled: 0 }, etpPositions: [{ isin: "XS0000000ETH", name: "Not traded", position: null }] }];
  const mcp = fakeMcp({ securities: [[]], crypto: [[crypto("x")]] }, { [ETP]: { currency: "EUR", dataPoints: [{ midPrice: 1, timestampUtc: "2026-01-01T00:00:00Z" }] } }, catalog);
  const input = await readHistoryInput(mcp, "UTC", "2026-02-01");
  expect(input.holdings).toContainEqual({ isin: ETP, filled: 10 });
  expect(Object.keys(input.charts)).toEqual([ETP]);
  expect(mcp.calls.filter(call => call.name === "get_transaction_details").map(call => call.args)).toEqual([{ transactionId: "x" }]);
});

it("refuses a coin held without an ETP position, since it has no shares or price to replay", async () => {
  const catalog = [{ ticker: "BTC", name: "Bitcoin", position: { filled: 0.5 }, etpPositions: [{ isin: ETP, name: "Not held", position: null }] }];
  await expect(readHistoryInput(fakeMcp({ securities: [[]], crypto: [[]] }, {}, catalog), "UTC", "2026-02-01")).rejects.toThrow("BTC");
});

it("only ever calls read tools", async () => {
  const catalog = [{ ticker: "BTC", name: "Bitcoin", position: { filled: 0.5 }, etpPositions: [{ isin: ETP, name: "Good", position: { filled: 10 } }] }];
  const mcp = fakeMcp({ securities: [[security("a")]], crypto: [[crypto("x")]] }, {}, catalog);
  await readHistoryInput(mcp, "UTC", "2026-02-01");
  expect([...new Set(mcp.calls.map(call => call.name))].sort()).toEqual(["get_portfolio_cash_breakdown", "get_portfolio_holdings", "get_security_chart", "get_transaction_details", "list_portfolio_transactions"]);
});
