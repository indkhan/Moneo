import { serviceDb } from "@/lib/bank/server";
import { calendarDate } from "@/lib/finance/calendar";
import { loadWorkspaceSettings } from "@/lib/settings";
import { ScalableError } from "./client";
import { cashSchema, holdingsSchema, overviewSchema, scalableWealth } from "./portfolio";
import { withScalable } from "./server";

/**
 * One sync: read holdings, totals and cash from Scalable, then write them as dated wealth records in
 * one database call. Market moves are valuations, not income; deposits and withdrawals are transfers
 * on the bank side. Errors are kept on the connection for the UI and rethrown.
 */
export async function syncScalable(connectionId: string, workspaceId: string) {
  const db = serviceDb();
  try {
    const { timezone } = await loadWorkspaceSettings(db, workspaceId);
    const snapshot = await withScalable(connectionId, workspaceId, async mcp => {
      const [holdings, overview, cash] = await Promise.all([mcp.callTool("get_portfolio_holdings"), mcp.callTool("get_portfolio_overview"), mcp.callTool("get_portfolio_cash_breakdown")]);
      return { holdings: holdingsSchema.parse(holdings), overview: overviewSchema.parse(overview), cash: cashSchema.parse(cash) };
    });
    const { items, portfolio } = scalableWealth(snapshot, workspaceId, calendarDate(new Date(), timezone));
    const { data, error } = await db.rpc("sync_scalable_wealth", { p_connection_id: connectionId, p_items: items, p_portfolio: portfolio });
    if (error) throw new Error(error.message);
    return { changed: data as number, portfolio };
  } catch (error) {
    // An ended login is already recorded as expired by withScalable.
    if (!(error instanceof ScalableError && error.expired))
      await db.from("scalable_connections").update({ last_error: "The Scalable sync failed. It retries on the next sync." }).eq("id", connectionId);
    throw error;
  }
}
