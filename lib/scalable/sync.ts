import { serviceDb } from "@/lib/service-db";
import { calendarDate } from "@/lib/finance/calendar";
import { loadWorkspaceSettings } from "@/lib/settings";
import { ScalableError } from "./client";
import { readCharts, saveCharts, tradeRows } from "./charts";
import { investmentsWatchlist, readTransactions, tradingAccess } from "./live";
import { cashSchema, holdingsSchema, overviewSchema, scalableWealth, type ScalableExtras } from "./portfolio";
import { withScalable } from "./server";
import { saveTransfers, transferRows } from "./transfers";
import { logError, logInfo } from "@/lib/log";

const optionalExtraIsSkipped = () => undefined;
const RECENT_TRANSACTIONS = 100, ACTIVITY_SHOWN = 8;

export async function syncScalable(connectionId: string, workspaceId: string) {
  const db = serviceDb();
  try {
    const { timezone } = await loadWorkspaceSettings(db, workspaceId);
    const previous = await db.from("scalable_connections").select("portfolio").eq("workspace_id", workspaceId).not("portfolio", "is", null);
    const fetchedAt = new Date().toISOString();
    const { snapshot, extras, access, recent, charts } = await withScalable(connectionId, workspaceId, async mcp => {
      const [holdings, overview, cash, activity, watchlist, access] = await Promise.all([mcp.callTool("get_portfolio_holdings"), mcp.callTool("get_portfolio_overview", { includeYearToDate: true }),
        mcp.callTool("get_portfolio_cash_breakdown"), mcp.callTool("list_portfolio_transactions", { pageSize: RECENT_TRANSACTIONS }).catch(optionalExtraIsSkipped),
        investmentsWatchlist(mcp).catch(optionalExtraIsSkipped), tradingAccess(mcp).catch(optionalExtraIsSkipped)]);
      const held = [...new Set(holdingsSchema.parse(holdings).holdings.filter(holding => holding.position.filled > 0).map(holding => holding.isin))];
      const charts = await readCharts(mcp, held, fetchedAt);
      const shown = (() => { try { return activity === undefined ? undefined : readTransactions(activity).slice(0, ACTIVITY_SHOWN); } catch { return undefined; } })();
      return { access, recent: activity, charts: { ...charts, held }, snapshot: { holdings: holdingsSchema.parse(holdings), overview: overviewSchema.parse(overview), cash: cashSchema.parse(cash) },
        extras: { ...(shown ? { activity: shown.map(({ id, date, status, type, description, shares, amountMinor, currencyCode }) => ({ id, date, status, type, description, shares, amountMinor, currencyCode })) } : {}),
          ...(watchlist ? { watchlist: watchlist.items.slice(0, 12).map(item => ({ isin: item.isin, name: item.name, priceMinor: item.quote?.priceMinor ?? null, currencyCode: item.quote?.currencyCode ?? "EUR", dayPercent: item.dayPercent })) } : {}) } };
    });
    const { items, portfolio } = scalableWealth(snapshot, workspaceId, calendarDate(new Date(), timezone));
    const known = new Set([...(previous.data ?? []).flatMap(row => { const ids = (row.portfolio as ScalableExtras | null); return [...(ids?.knownItemIds ?? []), ...(ids?.itemIds ?? [])]; }), ...items.map(item => item.id)]);
    const { data, error } = await db.rpc("sync_scalable_wealth", { p_connection_id: connectionId, p_items: items, p_portfolio: { ...portfolio, ...extras, knownItemIds: [...known] }, p_fetched_at: fetchedAt });
    if (error) throw new Error(error.message);
    if (recent !== undefined) try { await saveTransfers(connectionId, transferRows(recent, timezone), false); } catch (cause) { logError("sync", "scalable_transfers_were_not_saved", "Scalable transfers were not saved", cause); }
    try {
      if (charts.failed) logError("sync", "scalable_charts_missing_for_requests", `Scalable charts missing for ${charts.failed} requests`);
      await saveCharts(connectionId, { charts: charts.rows, trades: recent === undefined ? [] : tradeRows(recent), held: charts.held });
    } catch (cause) { logError("sync", "scalable_charts_were_not_saved", "Scalable charts were not saved", cause); }
    if (access) {
      const saved = await db.from("scalable_connections").update({ trading_access: access }).eq("id", connectionId);
      if (saved.error) throw new Error(saved.error.message);
    }
    logInfo("sync", "scalable.sync_finish", `Scalable sync updated ${data as number} items`, { connectionId, holdings: items.length }, { workspaceId });
    return { changed: data as number, portfolio };
  } catch (error) {
    logError("sync", "scalable.sync_failed", "Scalable sync failed", { connectionId, error }, { workspaceId });
    if (!(error instanceof ScalableError && error.expired))
      await db.from("scalable_connections").update({ last_error: "The Scalable sync failed. It retries on the next sync." }).eq("id", connectionId);
    throw error;
  }
}
