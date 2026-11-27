import type { SupabaseClient } from "@supabase/supabase-js";
import { displayFormat } from "@/lib/display-format";
import { loadWealthEvents } from "@/lib/finance/net-worth";
import { loadWealthItems } from "@/lib/finance/wealth";
import { serviceDb } from "@/lib/service-db";
import { loadPositionChart, type PositionChart } from "./charts";
import { holdingView, type HoldingView } from "./holding-view";
import { scalableItemId, type ScalablePortfolio } from "./portfolio";

type Workspace = { id: string; locale: string; timezone: string };

export async function latestPortfolio(db: SupabaseClient, workspaceId: string): Promise<ScalablePortfolio | null> {
  const { data, error } = await db.from("scalable_connections").select("portfolio").eq("workspace_id", workspaceId).in("status", ["active", "expired", "error"])
    .not("portfolio", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.portfolio ?? null) as ScalablePortfolio | null;
}

async function storedIsin(db: SupabaseClient, workspaceId: string, itemId: string) {
  const results = await Promise.all([db.from("scalable_security_charts").select("isin").eq("workspace_id", workspaceId),
    db.from("scalable_security_trades").select("isin").eq("workspace_id", workspaceId)]);
  for (const result of results) if (result.error) throw new Error(result.error.message);
  return results.flatMap(result => result.data ?? []).map(row => row.isin as string).find(isin => scalableItemId(workspaceId, `isin:${isin}`) === itemId) ?? null;
}

async function pricedChart(db: SupabaseClient, workspaceId: string, isin: string | null): Promise<PositionChart> {
  if (!isin) return { periods: [], trades: [] };
  const [chart, details] = await Promise.all([loadPositionChart(db, workspaceId, isin),
    serviceDb().from("scalable_trade_details").select("provider_id, price_text").eq("workspace_id", workspaceId).eq("isin", isin)]);
  if (details.error) throw new Error(details.error.message);
  const prices = new Map((details.data ?? []).map(row => [row.provider_id, row.price_text]));
  return { ...chart, trades: chart.trades.map(trade => ({ ...trade, price: (trade.id ? prices.get(trade.id) : null) ?? null })) };
}

export async function loadHolding(db: SupabaseClient, workspace: Workspace, itemId: string): Promise<HoldingView | null> {
  const [items, events, { isin, chart }, portfolio] = await Promise.all([
    loadWealthItems(db, workspace.id), loadWealthEvents(db, workspace.id, itemId),
    storedIsin(db, workspace.id, itemId).then(async isin => ({ isin, chart: await pricedChart(db, workspace.id, isin) })), latestPortfolio(db, workspace.id),
  ]);
  const item = items.find(entry => entry.id === itemId && entry.kind === "holding");
  if (!item || !portfolio?.itemIds?.includes(itemId)) return null;
  return holdingView({ item, isin, events, chart, timeZone: workspace.timezone,
    format: displayFormat(workspace.locale, workspace.timezone), portfolioTotalMinor: portfolio.currency === item.currency_code ? BigInt(portfolio.totalMinor) : null });
}
