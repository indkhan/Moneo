import { serviceDb } from "@/lib/bank/server";
import { calendarDate } from "@/lib/finance/calendar";
import { loadWorkspaceSettings } from "@/lib/settings";
import { ScalableError } from "./client";
import { investmentsWatchlist, readTransactions, tradingAccess } from "./live";
import { cashSchema, holdingsSchema, overviewSchema, scalableWealth, type ScalableExtras } from "./portfolio";
import { withScalable } from "./server";
import { saveTransfers, transferRows } from "./transfers";

const RECENT_TRANSACTIONS = 100, ACTIVITY_SHOWN = 8;

/**
 * One sync: read holdings, totals and cash from Scalable, then write them as dated wealth records in
 * one database call. Market moves are valuations, not income; deposits and withdrawals are transfers
 * on the bank side. Errors are kept on the connection for the UI and rethrown.
 */
export async function syncScalable(connectionId: string, workspaceId: string) {
  const db = serviceDb();
  try {
    const { timezone } = await loadWorkspaceSettings(db, workspaceId);
    const previous = await db.from("scalable_connections").select("portfolio").eq("workspace_id", workspaceId).not("portfolio", "is", null);
    // Taken before reading: two syncs can finish in the opposite order, and the older read must not win.
    const fetchedAt = new Date().toISOString();
    const { snapshot, extras, access, recent } = await withScalable(connectionId, workspaceId, async mcp => {
      // Activity and watchlist are extras: a failure there never stops the valuation sync.
      // So are the access level the chat uses to offer trading, and only a known level is saved.
      const [holdings, overview, cash, activity, watchlist, access] = await Promise.all([mcp.callTool("get_portfolio_holdings"), mcp.callTool("get_portfolio_overview", { includeYearToDate: true }),
        mcp.callTool("get_portfolio_cash_breakdown"), mcp.callTool("list_portfolio_transactions", { pageSize: RECENT_TRANSACTIONS }).catch(() => undefined),
        investmentsWatchlist(mcp).catch(() => undefined), tradingAccess(mcp).catch(() => undefined)]);
      const shown = (() => { try { return activity === undefined ? undefined : readTransactions(activity).slice(0, ACTIVITY_SHOWN); } catch { return undefined; } })();
      return { access, recent: activity, snapshot: { holdings: holdingsSchema.parse(holdings), overview: overviewSchema.parse(overview), cash: cashSchema.parse(cash) },
        extras: { ...(shown ? { activity: shown.map(({ id, date, status, type, description, shares, amountMinor, currencyCode }) => ({ id, date, status, type, description, shares, amountMinor, currencyCode })) } : {}),
          ...(watchlist ? { watchlist: watchlist.items.slice(0, 12).map(item => ({ isin: item.isin, name: item.name, priceMinor: item.quote?.priceMinor ?? null, currencyCode: item.quote?.currencyCode ?? "EUR", dayPercent: item.dayPercent })) } : {}) } };
    });
    const { items, portfolio } = scalableWealth(snapshot, workspaceId, calendarDate(new Date(), timezone));
    const known = new Set([...(previous.data ?? []).flatMap(row => { const ids = (row.portfolio as ScalableExtras | null); return [...(ids?.knownItemIds ?? []), ...(ids?.itemIds ?? [])]; }), ...items.map(item => item.id)]);
    const { data, error } = await db.rpc("sync_scalable_wealth", { p_connection_id: connectionId, p_items: items, p_portfolio: { ...portfolio, ...extras, knownItemIds: [...known] }, p_fetched_at: fetchedAt });
    if (error) throw new Error(error.message);
    // Saved after the values, so a transfer on record has been read into them. Like activity, it never stops the valuation sync.
    if (recent !== undefined) try { await saveTransfers(connectionId, transferRows(recent, timezone), false); } catch (cause) { console.error("Scalable transfers were not saved", cause); }
    if (access) {
      const saved = await db.from("scalable_connections").update({ trading_access: access }).eq("id", connectionId);
      if (saved.error) throw new Error(saved.error.message);
    }
    return { changed: data as number, portfolio };
  } catch (error) {
    // An ended login is already recorded as expired by withScalable.
    if (!(error instanceof ScalableError && error.expired))
      await db.from("scalable_connections").update({ last_error: "The Scalable sync failed. It retries on the next sync." }).eq("id", connectionId);
    throw error;
  }
}
