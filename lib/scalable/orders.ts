import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatMoney } from "@/lib/finance/format";
import { ScalableError, type ScalableMcp } from "./client";
import { READ_ONLY_TRADING, readTransactions, toMinor, tradingAccess } from "./live";

// Buying, selling and cancelling on Scalable from chat and calls. The model only ever asks Scalable for a
// preview; the preview's submission (with Scalable's one-time confirmation proof) is stored on a card and
// never returned to the model. Only the owner's tap on that card submits it (applyScalableProposal).

type Context = { supabase: SupabaseClient; workspace: { id: string; locale: string }; chatRequestId?: string };
type Run = <T>(work: (mcp: ScalableMcp) => Promise<T>) => Promise<T>;
export const TRADE_KINDS = ["scalable_order", "scalable_cancel"];

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const positive = z.string().trim().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/).refine(value => Number(value) > 0, "Must be more than 0");
export const orderInputSchema = z.object({
  side: z.enum(["buy", "sell"]),
  isin: z.string().regex(ISIN).describe("From investments_portfolio or investments_security search"),
  amount: positive.optional().describe("Buy only: money to spend in the security's currency. Scalable buys whole shares up to it"),
  shares: positive.optional().describe("Number of shares; required to sell"),
  orderType: z.enum(["market", "limit"]),
  limitPrice: positive.optional().describe("Limit orders only: the highest price to buy at or the lowest to sell at"),
}).strict();
export type OrderInput = z.infer<typeof orderInputSchema>;

function checkOrder(input: OrderInput) {
  if (input.side === "sell" && (!input.shares || input.amount)) throw new Error("A sale needs the number of shares");
  if (input.side === "buy" && Boolean(input.amount) === Boolean(input.shares)) throw new Error("A purchase needs either an amount or a number of shares");
  if ((input.orderType === "limit") !== Boolean(input.limitPrice)) throw new Error(input.orderType === "limit" ? "A limit order needs a limit price" : "Only limit orders take a limit price");
}

const text = z.union([z.string(), z.number()]).transform(String);
const money = z.object({ amount: text.nullable().optional() }).nullable().optional();
const previewSchema = z.object({
  brokerHandoff: z.object({ url: z.string().url().optional() }).nullable().optional(),
  marketQuote: z.object({ midPrice: text.nullable().optional(), askPrice: text.nullable().optional(), bidPrice: text.nullable().optional(), currency: z.string().regex(/^[A-Z]{3}$/),
    isOutdated: z.boolean().optional(), timestampUtc: z.string().nullable().optional() }),
  calculation: z.object({ shares: text, estimatePrice: text.nullable().optional(), estimatedOrderVolume: text.nullable().optional(), isWholePositionSold: z.boolean().nullable().optional() }),
  tradability: z.object({ tradable: z.boolean(), selectedVenueLabel: z.string().nullable().optional(), selectedVenueUnavailabilityReason: z.string().nullable().optional(), status: z.string().optional() }),
  exAnteCosts: z.object({ entryCosts: z.object({ total: money }).nullable().optional(), exitCosts: z.object({ total: money }).nullable().optional(),
    ongoingCosts: z.object({ total: money }).nullable().optional() }).nullable().optional(),
  priceWarnings: z.array(z.object({ message: z.string() }).passthrough()).nullable().optional(),
  requiredAcknowledgements: z.array(z.object({ id: z.string(), required: z.boolean().optional() }).passthrough()).nullable().optional(),
  documentLinks: z.object({ primaryKid: z.object({ label: z.string(), url: z.string().url() }).nullable().optional() }).nullable().optional(),
  userReview: z.string().max(20000),
  expiresAt: z.string(),
  submission: z.object({
    executionIntent: z.object({ side: z.enum(["buy", "sell"]), isin: z.string().regex(ISIN), numberOfShares: z.string(), orderType: z.string(), currency: z.string() }).passthrough(),
    confirmationContext: z.object({ requiredAcknowledgementIds: z.array(z.string()) }).passthrough(),
    confirmationProof: z.string().max(120),
  }).passthrough(),
});

/** What a trade card shows: Scalable's own figures, exactly, in minor units, and its complete review text. */
export type TradeReview = {
  action: "buy" | "sell" | "cancel"; name: string; isin: string | null; shares: string | null; orderType: string | null; currencyCode: string;
  limitPriceMinor: string | null; estimatePriceMinor: string | null; estimatedTotalMinor: string | null; entryCostMinor: string | null; exitCostMinor: string | null;
  quote: { midMinor: string | null; bidMinor: string | null; askMinor: string | null; at: string | null; outdated: boolean } | null;
  venue: string | null; wholePosition: boolean; warnings: string[]; expiresAt: string | null; brokerUrl: string | null; kid: { label: string; url: string } | null; review: string | null; status?: string;
};
const payloadSchema = z.object({ connectionId: z.uuid(), side: z.enum(["buy", "sell"]), expiresAt: z.string(), submission: previewSchema.shape.submission }).strict();
const cancelPayloadSchema = z.object({ connectionId: z.uuid(), orderId: z.string().min(1).max(200) }).strict();

const nameOf = async (mcp: ScalableMcp, isin: string) => {
  const found = await mcp.callTool("get_security_quote", { isin }).catch(() => null) as { security?: { name?: unknown } } | null;
  return typeof found?.security?.name === "string" ? found.security.name.slice(0, 120) : isin;
};
const minorOf = (value: string | null | undefined, currency: string) => value == null || value === "" ? null : toMinor(value, currency);

async function store(context: Context, row: { kind: string; title: string; detail: string; payload: unknown; review: TradeReview }) {
  const { data, error } = await context.supabase.from("agent_proposals").insert({ workspace_id: context.workspace.id, agent: "chat", kind: row.kind,
    ...(context.chatRequestId ? { chat_request_id: context.chatRequestId } : {}), conflict_key: `${row.kind}:${crypto.randomUUID()}`,
    title: row.title.slice(0, 200), detail: row.detail.slice(0, 500), payload: row.payload, evidence: { trade: row.review }, confidence: 100 }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

/**
 * Asks Scalable for an order preview and shows it as a card. Places nothing. The model gets the card's
 * title and expiry, never the submission. Read-only access, an untradable security or a preview that needs
 * a warning accepted in Scalable end here without a card.
 */
export async function proposeScalableOrder(context: Context, connectionId: string, run: Run, input: OrderInput) {
  checkOrder(input);
  const outcome = await run(async mcp => {
    if (await tradingAccess(mcp) === "read") return { readOnly: true as const };
    const quantity = input.amount ? { mode: "amount", amount: input.amount } : { mode: "shares", shares: input.shares };
    const order = input.orderType === "limit" ? { type: "limit", limitPrice: input.limitPrice } : { type: "market" };
    const [raw, name] = await Promise.all([mcp.callTool(input.side === "buy" ? "preview_buy_order" : "preview_sell_order", { isin: input.isin, quantity, order }), nameOf(mcp, input.isin)]);
    return { preview: previewSchema.parse(raw), name };
  });
  if ("readOnly" in outcome) return { shown: false as const, readOnly: true, message: READ_ONLY_TRADING };
  const { preview, name } = outcome, currency = preview.marketQuote.currency, brokerUrl = preview.brokerHandoff?.url ?? null;
  if (!preview.tradability.tradable) return { shown: false as const, message: `Scalable can't take this order: ${preview.tradability.selectedVenueUnavailabilityReason ?? preview.tradability.status ?? "not tradable"}.` };
  // Scalable's suitability warnings are not shown in Moneo yet, so an order that needs one is finished in Scalable.
  if ((preview.requiredAcknowledgements ?? []).some(item => item.required !== false) || preview.submission.confirmationContext.requiredAcknowledgementIds.length)
    return { shown: false as const, needsScalable: true, brokerUrl, message: "Scalable needs a warning accepted for this product first. It can only be ordered in the Scalable app." };
  const intent = preview.submission.executionIntent;
  const review: TradeReview = {
    action: intent.side, name, isin: intent.isin, shares: intent.numberOfShares, orderType: intent.orderType, currencyCode: currency,
    limitPriceMinor: minorOf(input.limitPrice, currency), estimatePriceMinor: minorOf(preview.calculation.estimatePrice, currency),
    estimatedTotalMinor: minorOf(preview.calculation.estimatedOrderVolume, currency),
    entryCostMinor: minorOf(preview.exAnteCosts?.entryCosts?.total?.amount, currency), exitCostMinor: minorOf(preview.exAnteCosts?.exitCosts?.total?.amount, currency),
    quote: { midMinor: minorOf(preview.marketQuote.midPrice, currency), bidMinor: minorOf(preview.marketQuote.bidPrice, currency), askMinor: minorOf(preview.marketQuote.askPrice, currency),
      at: preview.marketQuote.timestampUtc ?? null, outdated: preview.marketQuote.isOutdated ?? false },
    venue: preview.tradability.selectedVenueLabel ?? null, wholePosition: preview.calculation.isWholePositionSold ?? false,
    warnings: (preview.priceWarnings ?? []).map(item => item.message).slice(0, 5), expiresAt: preview.expiresAt, brokerUrl,
    kid: preview.documentLinks?.primaryKid ?? null, review: preview.userReview,
  };
  const price = (minor: string | null) => minor ? formatMoney(minor, currency, context.workspace.locale) : "";
  const title = `${intent.side === "buy" ? "Buy" : "Sell"} ${intent.numberOfShares} × ${name}${intent.orderType === "limit" ? ` at ${price(review.limitPriceMinor)} or better` : ""}`;
  const detail = [intent.orderType === "limit" ? "Limit order" : "Market order", review.estimatedTotalMinor && `about ${price(review.estimatedTotalMinor)}`,
    review.entryCostMinor && `${price(review.entryCostMinor)} order cost`, review.venue].filter(Boolean).join(" · ");
  const id = await store(context, { kind: "scalable_order", title, detail, review,
    payload: payloadSchema.parse({ connectionId, side: intent.side, expiresAt: preview.expiresAt, submission: preview.submission }) });
  return { shown: true as const, proposalId: id, title, expiresAt: preview.expiresAt,
    ...(input.amount && review.estimatedTotalMinor ? { note: `Scalable buys whole shares: ${intent.numberOfShares} for about ${price(review.estimatedTotalMinor)}.` } : {}) };
}

/** Shows a card to cancel one open order. The order must be one Scalable lists for this portfolio. */
export async function proposeScalableCancel(context: Context, connectionId: string, run: Run, orderId: string) {
  const outcome = await run(async mcp => {
    if (!(await mcp.listTools()).some(tool => tool.name === "cancel_order")) return { readOnly: true as const };
    const order = readTransactions(await mcp.callTool("list_portfolio_transactions", { pageSize: 50 })).find(row => row.id === orderId);
    return { order, name: order?.isin ? await nameOf(mcp, order.isin) : null };
  });
  if ("readOnly" in outcome) return { shown: false as const, readOnly: true, message: READ_ONLY_TRADING };
  const { order, name } = outcome;
  if (!order) return { shown: false as const, message: "Scalable doesn't list that order. Use investments_transactions to find the open order's id." };
  const label = name ?? order.description ?? "order";
  const review: TradeReview = { action: "cancel", name: label, isin: order.isin, shares: order.shares, orderType: null, currencyCode: order.currencyCode,
    limitPriceMinor: order.limitPriceMinor, estimatePriceMinor: null, estimatedTotalMinor: order.amountMinor, entryCostMinor: null, exitCostMinor: null, quote: null,
    venue: null, wholePosition: false, warnings: [], expiresAt: null, brokerUrl: null, kid: null, review: null, status: order.status };
  const title = `Cancel ${order.type} order: ${order.shares ? `${order.shares} × ` : ""}${label}`;
  const id = await store(context, { kind: "scalable_cancel", title, detail: `Placed ${order.date} · ${order.status.toLowerCase()}`, review,
    payload: cancelPayloadSchema.parse({ connectionId, orderId }) });
  return { shown: true as const, proposalId: id, title };
}

/** Thrown when Scalable may have placed or cancelled the order but did not say so: the card is never retried. */
export class OrderOutcomeUnknown extends Error { name = "OrderOutcomeUnknown"; }

const submitSchema = z.object({ orderId: z.string().optional(), transactionReference: z.string().nullable().optional(), accepted: z.boolean().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).nullable().optional() }).passthrough();

/**
 * Runs when the owner taps the card. Sends exactly the stored submission once; an expired preview is refused
 * before anything is sent. A refusal from Scalable means nothing happened; any other failure after sending is an
 * unknown outcome, so the card tells the owner to check Scalable instead of offering to send again.
 */
export async function applyScalableProposal(kind: string, payload: unknown, open: (connectionId: string) => Run, now = Date.now()) {
  if (kind === "scalable_order") {
    const order = payloadSchema.parse(payload);
    if (Date.parse(order.expiresAt) <= now) throw new Error("This preview expired, so nothing was sent. Ask again for a fresh preview.");
    const result = await send(open(order.connectionId), order.side === "buy" ? "submit_buy_order" : "submit_sell_order", { submission: order.submission, acknowledgementIds: [] });
    return { href: "/money/wealth", orderId: result.orderId ?? null, reference: result.transactionReference ?? null };
  }
  const cancel = cancelPayloadSchema.parse(payload);
  await send(open(cancel.connectionId), "cancel_order", { orderId: cancel.orderId });
  return { href: "/money/wealth", orderId: cancel.orderId, cancelled: true };
}

async function send(run: Run, tool: string, args: Record<string, unknown>) {
  let sent = false;
  let result: z.infer<typeof submitSchema>;
  try {
    result = submitSchema.parse(await run(mcp => { sent = true; return mcp.callTool(tool, args); }));
  } catch (cause) {
    // Before the call, or a decision from Scalable itself (expired, invalid, not cancelable, login ended): nothing happened.
    if (!sent || (cause instanceof ScalableError && (cause.refused || cause.expired || cause.status < 500))) throw cause;
    throw new OrderOutcomeUnknown("Scalable didn't confirm this. Check the Scalable app before trying again; Moneo won't send it again.");
  }
  // An answer that carries an error is Scalable refusing: nothing was placed or cancelled.
  if (result.error) throw new ScalableError(`Scalable refused: ${result.error.message ?? result.error.code ?? "unknown reason"}`, 400, false, true);
  return result;
}
