// A local stand-in for Scalable's MCP server, for browser tests and demos. Start the app with
// SCALABLE_MCP_ORIGIN=http://127.0.0.1:3043 and run `node e2e/mocks/scalable-mcp.mjs`.
// All data is made up. POST /mode {"access":"read"|"full"} switches access; GET /calls lists
// every tool call, so a test can prove what was (and was not) submitted.
import { createServer } from "node:http";

const PORT = Number(process.env.SCALABLE_MOCK_PORT ?? 3043);
const ISIN = "DE000A0TEST1", ISIN2 = "US0000TEST02";
const READ_TOOLS = ["get_portfolio_holdings", "get_portfolio_overview", "get_portfolio_cash_breakdown", "list_portfolio_transactions", "list_watchlist_items",
  "get_security_quote", "search_securities", "get_security_chart", "get_security_news"];
const TRADE_TOOLS = ["preview_buy_order", "preview_sell_order", "submit_buy_order", "submit_sell_order", "cancel_order"];
let access = "full";
const calls = [];

const names = { [ISIN]: "Test Tech ETF (Acc)", [ISIN2]: "Example Robotics Inc." };
const prices = { [ISIN]: 7.4575, [ISIN2]: 182.4 };
const holdings = { holdings: [
  { isin: ISIN, name: names[ISIN], fifoPrice: 7.88, valuation: 22.37, valuationCurrency: "EUR", currentQuote: { currency: "EUR", midPrice: prices[ISIN] }, position: { filled: 3 } },
  { isin: ISIN2, name: names[ISIN2], fifoPrice: 160.1, valuation: 364.8, valuationCurrency: "EUR", currentQuote: { currency: "EUR", midPrice: prices[ISIN2] }, position: { filled: 2 } },
], cryptoHoldings: [] };
const overview = { valuation: { total: 887.17, securities: 387.17, crypto: 0 }, timestamps: { valuationTimestampUtc: new Date().toISOString() },
  performance: [["INTRADAY", 4.2], ["ONE_WEEK", -6.1], ["ONE_MONTH", 18.4], ["THREE_MONTHS", 22.9], ["YEAR_TO_DATE", 31.5], ["ONE_YEAR", 40.2], ["MAX", 43.7]]
    .map(([timeframe, simpleAbsoluteReturn]) => ({ timeframe, simpleAbsoluteReturn })) };
const transactions = [
  { id: "open-1", kind: "security", status: "PENDING", currency: "EUR", lastEventAt: new Date().toISOString(), description: names[ISIN2],
    security: { isin: ISIN2, transactionType: "SINGLE", quantity: "1", amount: "-150", side: "BUY", limitPrice: "150" } },
  { id: "done-1", kind: "security", status: "SETTLED", currency: "EUR", lastEventAt: "2026-11-02T16:56:06Z", description: names[ISIN],
    security: { isin: ISIN, transactionType: "SINGLE", quantity: "3", amount: "-23.64", side: "BUY", limitPrice: null } },
  { id: "cash-1", kind: "cash", status: "SETTLED", currency: "EUR", lastEventAt: "2026-11-01T09:00:00Z", description: "Deposit", cash: { transactionType: "DEPOSIT", amount: "500" } },
];

function preview(side, { isin, quantity, order }) {
  const price = prices[isin] ?? 10, ask = Math.round(price * 1.009 * 1000) / 1000, bid = Math.round(price * 0.991 * 1000) / 1000;
  const shares = quantity.mode === "shares" ? String(quantity.shares) : String(Math.max(1, Math.floor(Number(quantity.amount) / ask)));
  const estimate = order.type === "limit" ? String(order.limitPrice) : String(side === "buy" ? ask : bid);
  const volume = String(Math.round(Number(shares) * Number(estimate) * 1000) / 1000);
  return {
    brokerHandoff: { url: `https://scalable.example/broker/security?isin=${isin}` },
    orderIntent: { side, isin, orderType: order.type },
    marketQuote: { midPrice: String(price), askPrice: String(ask), bidPrice: String(bid), currency: "EUR", isOutdated: false, timestampUtc: new Date().toISOString() },
    calculation: { shares, estimatePrice: estimate, estimatedOrderVolume: volume, isWholePositionSold: false },
    tradability: { tradable: true, selectedVenueLabel: "Example Exchange", status: "TRADABLE_WITHOUT_APPROPRIATENESS" },
    exAnteCosts: { entryCosts: { total: { amount: "0.99" } }, exitCosts: { total: { amount: "0.99" } } },
    priceWarnings: [], requiredAcknowledgements: [],
    userReview: `Order review\n\nOrder:\n  Side: ${side}\n  isin: ${isin}\n  Shares: ${shares}\n  Order type: ${order.type}\n\nEstimate:\n  Estimate price: ${estimate}\n  Estimated order volume: ${volume}\n\nEx-ante costs:\n  Entry total amount: 0.99`,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    submission: { executionIntent: { portfolioId: "demo", side, isin, venue: "SEIX", currency: "EUR", numberOfShares: shares, orderType: order.type,
      limitPrice: order.type === "limit" ? String(order.limitPrice) : null, stopPrice: null, appropriatenessId: null, acknowledgedWarningVersion: null },
      confirmationContext: { requiredAcknowledgementIds: [] }, confirmationProof: `c1.demo.${"A".repeat(22)}.${"B".repeat(43)}` },
  };
}

function call(name, args) {
  switch (name) {
    case "get_portfolio_holdings": return holdings;
    case "get_portfolio_overview": return overview;
    case "get_portfolio_cash_breakdown": return { cash: { cashBalance: 500, buyingPower: 500, pendingBuyOrdersAmount: 150 } };
    case "list_portfolio_transactions": return { transactions: args.statuses?.some(status => /pending/i.test(status)) ? transactions.filter(row => row.status === "PENDING") : transactions, page: { nextCursor: null } };
    case "list_watchlist_items": return { items: [{ isin: "IE0000TEST03", name: "Example World ETF", securityType: "ETF", currentQuote: { midPrice: 101.2, currency: "EUR" } }] };
    case "get_security_quote": return { security: { isin: args.isin, name: names[args.isin] ?? "Example security", securityType: "ETF", quote: { midPrice: prices[args.isin] ?? 10, currency: "EUR",
      performances: [{ timeframe: "INTRADAY", performance: 0.011 }, { timeframe: "ONE_MONTH", performance: 0.052 }] } } };
    case "search_securities": return { results: Object.entries(names).filter(([, name]) => name.toLowerCase().includes(String(args.query).toLowerCase().split(" ")[0]))
      .map(([isin, name]) => ({ isin, name, securityType: "ETF", currentQuote: { midPrice: prices[isin], currency: "EUR" } })) };
    case "get_security_chart": return { currency: "EUR", dataPoints: Array.from({ length: 30 }, (_, day) => ({ midPrice: 7 + day / 40, timestampUtc: new Date(Date.now() - (30 - day) * 86400000).toISOString() })) };
    case "get_security_news": return { summary: { short: "Made-up news for the demo.", long: "Nothing happened; this is a test fixture." } };
    case "preview_buy_order": return preview("buy", args);
    case "preview_sell_order": return preview("sell", args);
    case "submit_buy_order": case "submit_sell_order": return { orderId: `order-${calls.length}`, transactionReference: `DEMO${calls.length}` };
    case "cancel_order": return { orderId: args.orderId, accepted: true };
    default: return null;
  }
}

const reply = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  if (req.url === "/calls") return reply(res, 200, calls);
  if (req.url === "/mode") { access = JSON.parse(raw).access; calls.length = 0; return reply(res, 200, { access }); }
  if (req.url === "/token") return reply(res, 200, { access_token: "mock-access", refresh_token: "mock-refresh", expires_in: 3600 });
  if (req.url !== "/mcp") return reply(res, 404, { error: "not_found" });
  const message = JSON.parse(raw);
  if (!("id" in message)) return reply(res, 202);
  const tools = [...READ_TOOLS, ...(access === "full" ? TRADE_TOOLS : [])];
  const answer = (result) => reply(res, 200, { jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "scalable-mock", version: "1" } });
  if (message.method === "tools/list") return answer({ tools: tools.map(name => ({ name, inputSchema: { type: "object" } })) });
  if (message.method === "tools/call") {
    const { name, arguments: args = {} } = message.params;
    calls.push({ name, args });
    if (!tools.includes(name)) return answer({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "forbidden" } }) }] });
    return answer({ structuredContent: call(name, args), content: [] });
  }
  return reply(res, 200, { jsonrpc: "2.0", id: message.id, error: { message: "unknown method" } });
}).listen(PORT, "127.0.0.1", () => console.log(`Scalable mock on http://127.0.0.1:${PORT}`));
