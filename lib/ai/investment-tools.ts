import { tool } from "ai";
import { z } from "zod";
import type { requireWorkspace } from "@/lib/auth";
import { investmentsPortfolio, investmentsSecurity, investmentsTransactions, investmentsWatchlist, securityInput, transactionsInput } from "@/lib/scalable/live";
import { orderInputSchema, proposeScalableCancel, proposeScalableOrder } from "@/lib/scalable/orders";
import { withScalable } from "@/lib/scalable/server";
import type { ScalableMcp } from "@/lib/scalable/client";

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
  const live = <T>(read: (mcp: ScalableMcp) => Promise<T>) => evidence(latest => withScalable(connectionId, latest.workspace.id, read));
  const run = <T>(workspaceId: string) => (work: (mcp: ScalableMcp) => Promise<T>) => withScalable(connectionId, workspaceId, work);
  // Unknown access (not synced since it was recorded) keeps the tools; they check Scalable live before a card.
  const trading = tradingAccess !== "read" && [message, ...priorUserText].some(text => TRADE_INTENT.test(text));
  const cardNote = "A card is shown below your answer with Scalable's preview, a countdown and a button the user taps to send it. It is not placed until they tap. Say it is waiting for them; do not repeat every figure.";
  return {
    investments_portfolio: tool({ description: "Live Scalable Capital portfolio: each position (shares, price, value, cost, gain in money and %), uninvested cash and buying power, crypto, and Scalable's own gain or loss per period (today, 1 week … all time). Also says whether trading is allowed (tradingAccess full or read).",
      inputSchema: z.object({}).strict(), execute: () => live(mcp => investmentsPortfolio(mcp)) }),
    investments_transactions: tool({ description: "Scalable buys, sells, deposits, withdrawals and dividends, newest first, with filters. Use statuses [\"pending\"] for open orders; an order's id is what cancelling needs.",
      inputSchema: transactionsInput, execute: input => live(mcp => investmentsTransactions(mcp, input)) }),
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
