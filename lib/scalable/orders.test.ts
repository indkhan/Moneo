import { describe, expect, it, vi } from "vitest";
import { ScalableError, type ScalableMcp } from "./client";
import { READ_ONLY_TRADING } from "./live";
import { applyScalableProposal, OrderOutcomeUnknown, proposeScalableCancel, proposeScalableOrder } from "./orders";

const ISIN = "DE000A0TEST1";
const FULL = ["get_portfolio_holdings", "preview_buy_order", "preview_sell_order", "submit_buy_order", "submit_sell_order", "cancel_order", "list_portfolio_transactions", "get_security_quote"];
const READ = ["get_portfolio_holdings", "list_portfolio_transactions", "get_security_quote"];
const submission = { executionIntent: { portfolioId: "pf1", side: "buy", isin: ISIN, venue: "SEIX", currency: "EUR", numberOfShares: "1", orderType: "market", limitPrice: null, stopPrice: null,
  appropriatenessId: null, acknowledgedWarningVersion: null }, confirmationContext: { requiredAcknowledgementIds: [] as string[] }, confirmationProof: "c1.abc.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" };
const preview = (overrides: Record<string, unknown> = {}) => ({
  brokerHandoff: { url: "https://scalable.example/trade" },
  marketQuote: { midPrice: "7.4575", askPrice: "7.526", bidPrice: "7.389", currency: "EUR", isOutdated: true, timestampUtc: "2026-11-06T21:30:12.561Z" },
  calculation: { shares: "1", estimatePrice: "7.526", estimatedOrderVolume: "7.526", isWholePositionSold: false },
  tradability: { tradable: true, selectedVenueLabel: "European Investor Exchange (EIX)", status: "TRADABLE_WITHOUT_APPROPRIATENESS" },
  exAnteCosts: { entryCosts: { total: { amount: "0.99" } }, exitCosts: { total: { amount: "0.99" } } },
  priceWarnings: [], requiredAcknowledgements: [], userReview: "Order review\n\nOrder:\n  Side: buy", issuedAt: "2026-11-07T15:55:54.579Z", expiresAt: "2026-11-07T16:00:54.000Z",
  submission, ...overrides,
});

function fakeMcp(tools: string[], answers: Record<string, unknown | (() => unknown)> = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const mcp = { connect: async () => {}, listTools: async () => tools.map(name => ({ name })),
    callTool: vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      const answer = answers[name];
      return typeof answer === "function" ? (answer as () => unknown)() : answer ?? {};
    }) } as unknown as ScalableMcp;
  return { mcp, calls, run: (<T>(work: (mcp: ScalableMcp) => Promise<T>) => work(mcp)) };
}
function fakeContext() {
  const inserted: Record<string, unknown>[] = [];
  const supabase = { from: () => ({ insert: (row: Record<string, unknown>) => { inserted.push(row); return { select: () => ({ single: async () => ({ data: { id: "00000000-0000-4000-8000-0000000000aa" }, error: null }) }) }; } }) };
  return { inserted, context: { supabase: supabase as never, workspace: { id: "ws", locale: "en-GB" }, chatRequestId: "00000000-0000-4000-8000-000000000001" } };
}
const CONNECTION = "00000000-0000-4000-8000-0000000000cc";

describe("Scalable order cards", () => {
  it("tells a read-only connection it cannot trade, without asking Scalable for a preview", async () => {
    const { mcp, calls, run } = fakeMcp(READ);
    const { context, inserted } = fakeContext();
    const result = await proposeScalableOrder(context, CONNECTION, run, { side: "buy", isin: ISIN, amount: "10", orderType: "market" });
    expect(result).toMatchObject({ shown: false, readOnly: true, message: READ_ONLY_TRADING });
    expect(calls).toEqual([]); expect(inserted).toEqual([]);
    void mcp;
  });

  it("stores Scalable's preview on a card and gives the model no way to submit it", async () => {
    const { calls, run } = fakeMcp(FULL, { preview_buy_order: preview(), get_security_quote: { security: { name: "Test Tech ETF" } } });
    const { context, inserted } = fakeContext();
    const result = await proposeScalableOrder(context, CONNECTION, run, { side: "buy", isin: ISIN, amount: "10", orderType: "market" });
    expect(calls.map(call => call.name).sort()).toEqual(["get_security_quote", "preview_buy_order"]);
    expect(calls.find(call => call.name === "preview_buy_order")?.args).toEqual({ isin: ISIN, quantity: { mode: "amount", amount: "10" }, order: { type: "market" } });
    expect(result).toMatchObject({ shown: true, title: "Buy 1 × Test Tech ETF", expiresAt: "2026-11-07T16:00:54.000Z" });
    // The confirmation proof stays in the stored payload; nothing the model reads contains it.
    expect(JSON.stringify(result)).not.toContain("c1.abc");
    expect(inserted[0]).toMatchObject({ kind: "scalable_order", agent: "chat", payload: { connectionId: CONNECTION, side: "buy", submission },
      evidence: { trade: { action: "buy", shares: "1", estimatedTotalMinor: "753", entryCostMinor: "99", venue: "European Investor Exchange (EIX)" } } });
    expect(JSON.stringify(inserted[0].evidence)).not.toContain("c1.abc");
  });

  it("sends a product that needs a warning accepted to Scalable instead of making a card", async () => {
    const { run } = fakeMcp(FULL, { preview_sell_order: preview({ requiredAcknowledgements: [{ id: "acknowledge_appropriateness_warning", required: true }] }) });
    const { context, inserted } = fakeContext();
    const result = await proposeScalableOrder(context, CONNECTION, run, { side: "sell", isin: ISIN, shares: "1", orderType: "limit", limitPrice: "9" });
    expect(result).toMatchObject({ shown: false, needsScalable: true, brokerUrl: "https://scalable.example/trade" });
    expect(inserted).toEqual([]);
  });

  it("refuses orders that don't add up before calling Scalable", async () => {
    const { calls, run } = fakeMcp(FULL);
    const { context } = fakeContext();
    await expect(proposeScalableOrder(context, CONNECTION, run, { side: "sell", isin: ISIN, amount: "10", orderType: "market" })).rejects.toThrow("number of shares");
    await expect(proposeScalableOrder(context, CONNECTION, run, { side: "buy", isin: ISIN, shares: "1", orderType: "limit" })).rejects.toThrow("limit price");
    expect(calls).toEqual([]);
  });

  it("only offers to cancel an order Scalable lists", async () => {
    const order = { id: "order-1", kind: "security", status: "PENDING", currency: "EUR", lastEventAt: "2026-11-07T10:00:00Z", description: "Test Tech ETF",
      security: { isin: ISIN, transactionType: "SINGLE", quantity: "3", amount: "-24.63", side: "BUY", limitPrice: "8.2" } };
    const { run } = fakeMcp(FULL, { list_portfolio_transactions: { transactions: [order] }, get_security_quote: { security: { name: "Test Tech ETF" } } });
    const { context, inserted } = fakeContext();
    expect(await proposeScalableCancel(context, CONNECTION, run, "missing")).toMatchObject({ shown: false });
    expect(await proposeScalableCancel(context, CONNECTION, run, "order-1")).toMatchObject({ shown: true, title: "Cancel buy order: 3 × Test Tech ETF" });
    expect(inserted[0]).toMatchObject({ kind: "scalable_cancel", payload: { connectionId: CONNECTION, orderId: "order-1" } });
  });
});

describe("tapping a trade card", () => {
  const payload = { connectionId: CONNECTION, side: "buy", expiresAt: "2026-11-07T16:00:54.000Z", submission };
  const before = Date.parse("2026-11-07T15:58:00Z"), after = Date.parse("2026-11-07T16:01:00Z");

  it("sends exactly the stored submission, once", async () => {
    const { calls, run } = fakeMcp(FULL, { submit_buy_order: { orderId: "order-9", transactionReference: "REF9" } });
    const result = await applyScalableProposal("scalable_order", payload, () => run, before);
    expect(calls).toEqual([{ name: "submit_buy_order", args: { submission, acknowledgementIds: [] } }]);
    expect(result).toMatchObject({ orderId: "order-9", reference: "REF9" });
  });

  it("sends nothing once the preview has expired", async () => {
    const { calls, run } = fakeMcp(FULL);
    await expect(applyScalableProposal("scalable_order", payload, () => run, after)).rejects.toThrow("expired");
    expect(calls).toEqual([]);
  });

  it("treats Scalable's refusal as nothing happened, and a lost answer as unknown", async () => {
    const refused = fakeMcp(FULL, { submit_buy_order: () => { throw new ScalableError("Scalable tool submit_buy_order failed: trade_confirmation_invalid", 502, false, true); } });
    await expect(applyScalableProposal("scalable_order", payload, () => refused.run, before)).rejects.toBeInstanceOf(ScalableError);
    const answerError = fakeMcp(FULL, { submit_buy_order: { error: { code: "trade_confirmation_expired", message: "expired" } } });
    await expect(applyScalableProposal("scalable_order", payload, () => answerError.run, before)).rejects.toThrow("Scalable refused");
    const lost = fakeMcp(FULL, { submit_buy_order: () => { throw new TypeError("fetch failed"); } });
    await expect(applyScalableProposal("scalable_order", payload, () => lost.run, before)).rejects.toBeInstanceOf(OrderOutcomeUnknown);
    const gateway = fakeMcp(FULL, { submit_buy_order: () => { throw new ScalableError("Scalable MCP returned 504", 504); } });
    await expect(applyScalableProposal("scalable_order", payload, () => gateway.run, before)).rejects.toBeInstanceOf(OrderOutcomeUnknown);
  });

  it("cancels the stored order id", async () => {
    const { calls, run } = fakeMcp(FULL, { cancel_order: { orderId: "order-1", accepted: true } });
    await applyScalableProposal("scalable_cancel", { connectionId: CONNECTION, orderId: "order-1" }, () => run, before);
    expect(calls).toEqual([{ name: "cancel_order", args: { orderId: "order-1" } }]);
  });
});
