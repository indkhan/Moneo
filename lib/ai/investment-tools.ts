import { tool } from "ai";
import { z } from "zod";
import type { requireWorkspace } from "@/lib/auth";
import { investmentsPortfolio, investmentsSecurity, investmentsTransactions, investmentsWatchlist, securityInput, transactionsInput } from "@/lib/scalable/live";
import { orderInputSchema, proposeScalableCancel, proposeScalableOrder } from "@/lib/scalable/orders";
import { withScalable } from "@/lib/scalable/server";
import type { ScalableMcp } from "@/lib/scalable/client";
import { scalableRead, scalableReadTools } from "@/lib/scalable/read-tools";
import { investigationCode } from "./investigation-code";

type Context = Awaited<ReturnType<typeof requireWorkspace>>;

/** The user asked to trade in this message or the two before it ("buy 2 shares", then "ok do it"). */
export const TRADE_INTENT = /\b(buy|sell|kauf\w*|verkauf\w*|orders?|purchase|invest|trade|cancel\w*|storn\w*)\b/i;

/**
 * Scalable tools for chat and calls. Reads go to Scalable live. The order tools only make cards: they ask Scalable
 * for a preview and store it; the model never gets a tool that submits. They exist only when the user asked to trade,
 * so a news article or other tool text cannot start one on its own, and never on a read-only connection.
 */
export function investmentTools({ connectionId, tradingAccess, message, priorUserText, evidence, context, onCard }: {
  connectionId: string; tradingAccess: "full" | "read" | null; message: string; priorUserText: string[];
  evidence: <T>(read: (latest: Context) => Promise<T>) => Promise<T>;
  context: () => Promise<Context & { chatRequestId: string }>;
  onCard: (proposalId: string) => void;
}) {
  const datasets = new Map<string, unknown>();
  let datasetBytes = 0;
  const live = <T>(read: (mcp: ScalableMcp) => Promise<T>, retainOnly = false) => evidence(async latest => {
    const value = await withScalable(connectionId, latest.workspace.id, read);
    const bytes = JSON.stringify(value).length;
    if (datasetBytes + bytes > 8_000_000) throw new Error("Investigation data limit reached; narrow the filters");
    const datasetId = `scalable_${datasets.size + 1}`;
    datasets.set(datasetId, value); datasetBytes += bytes;
    return { datasetId, ...(retainOnly ? { retained: true } : { data: value }) };
  });
  const run = <T>(workspaceId: string) => (work: (mcp: ScalableMcp) => Promise<T>) => withScalable(connectionId, workspaceId, work);
  // Unknown access (not synced since it was recorded) keeps the tools; they check Scalable live before a card.
  const trading = tradingAccess !== "read" && [message, ...priorUserText].some(text => TRADE_INTENT.test(text));
  const cardNote = "A card is shown below your answer with Scalable's preview, a countdown and a button the user taps to send it. It is not placed until they tap. Say it is waiting for them; do not repeat every figure.";
  return {
    investments_readTools: tool({ description: "Discover Scalable's approved read operations, descriptions and input schemas. Use when the convenient investment tools omit details you need.", inputSchema: z.object({}).strict(), execute: () => live(scalableReadTools) }),
    investments_read: tool({ description: "Call a discovered Scalable read operation with its documented arguments. Preserves raw details and pagination. Cannot trade or modify data. retainOnly stores data for calculation without sending the full result to the model.", inputSchema: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()), retainOnly: z.boolean().optional() }).strict(), execute: input => live(mcp => scalableRead(mcp, input.name, input.arguments), input.retainOnly) }),
    investments_calculate: tool({ description: "Execute JavaScript in an isolated local sandbox. Pass datasetIds from reads; data.datasets maps each id to its original result. Optional data is available as data.input. Body must return JSON. Use BigInt for money and keep currencies separate. No imports, network or filesystem. Filter, join and calculate from evidence rather than inventing inputs. Handles last for this request only.", inputSchema: z.object({ code: z.string().max(30000), datasetIds: z.array(z.string()).max(200), data: z.unknown().optional() }).strict(), execute: input => evidence(async () => {
      const selected: Record<string, unknown> = {};
      for (const id of input.datasetIds) {
        if (!datasets.has(id)) throw new Error("Unknown dataset; retrieve it again in this request");
        selected[id] = datasets.get(id);
      }
      return investigationCode(input.code, { datasets: selected, input: input.data });
    }) }),
    investments_portfolio: tool({ description: "Live Scalable Capital portfolio: each position (shares, price, value, cost, gain in money and %), uninvested cash and buying power, crypto, and Scalable's own gain or loss per period (today, 1 week … all time). Also says whether trading is allowed (tradingAccess full or read).",
      inputSchema: z.object({}).strict(), execute: () => live(mcp => investmentsPortfolio(mcp)) }),
    investments_transactions: tool({ description: "Scalable buys, sells, deposits, withdrawals and dividends, newest first, with filters. Use allPages for complete matching security history; retainOnly stores it for calculations without filling model context. Otherwise follow nextCursor with the same filters. Use statuses [\"pending\"] for open orders; an order's id is what cancelling needs.",
      inputSchema: transactionsInput.extend({ retainOnly: z.boolean().optional() }), execute: input => live(mcp => investmentsTransactions(mcp, input), input.retainOnly) }),
    investments_security: tool({ description: "Any security on Scalable, owned or not: search by name/ticker/ISIN, its live quote and moves, its price chart over a timeframe, or a news summary.",
      inputSchema: securityInput, execute: input => live(mcp => investmentsSecurity(mcp, input)) }),
    investments_watchlist: tool({ description: "The user's Scalable watchlist with live prices.", inputSchema: z.object({}).strict(), execute: () => live(mcp => investmentsWatchlist(mcp)) }),
    ...(trading ? {
      investments_order: tool({ description: "The user asked to buy or sell a security on Scalable. Gets Scalable's preview and shows it as a card the user taps to place; nothing is placed by this tool. Market or limit orders. Buy by amount or shares; sell by shares. Find the ISIN first: for something the user already holds, use the ISIN from investments_portfolio, since share classes (Acc/Dist) differ. If it returns readOnly or a message instead of a card, tell the user exactly that.",
        inputSchema: orderInputSchema, execute: input => evidence(async () => {
          const latest = await context();
          const shown = await proposeScalableOrder(latest, connectionId, run(latest.workspace.id), input);
          if (shown.shown) onCard(shown.proposalId);
          return shown.shown ? { proposed: shown.title, expiresAt: shown.expiresAt, ...(shown.note ? { sizing: shown.note } : {}), note: cardNote } : shown;
        }) }),
      investments_cancelOrder: tool({ description: "The user asked to cancel an open Scalable order. Pass its id from investments_transactions (statuses pending). Shows a card the user taps to cancel; nothing is cancelled by this tool.",
        inputSchema: z.object({ orderId: z.string().trim().min(1).max(200) }).strict(), execute: ({ orderId }) => evidence(async () => {
          const latest = await context();
          const shown = await proposeScalableCancel(latest, connectionId, run(latest.workspace.id), orderId);
          if (shown.shown) onCard(shown.proposalId);
          return shown.shown ? { proposed: shown.title, note: cardNote } : shown;
        }) }),
    } : {}),
  };
}
