import type { requireWorkspace } from "@/lib/auth";
import { activeScalableConnection, investmentsPortfolio, investmentsSecurity, investmentsTransactions, investmentsWatchlist, PERIODS, toMinor, type securityInput } from "./live";
import type { ScalablePortfolio } from "./portfolio";
import { withScalable } from "./server";
import type { ScalableMcp } from "./client";
import type { z } from "zod";

type Context = Awaited<ReturnType<typeof requireWorkspace>>;

/**
 * Scalable data for artifacts (Pages and Home cards). By default it is what the last sync saved, the same
 * figures Wealth shows; Settings can switch artifacts to Scalable live. Both give the same shape, so a card
 * keeps working when the owner flips the setting. `dataFrom` and `syncedAt` say which one it is.
 */
const live = async <T>(context: Context, read: (mcp: ScalableMcp) => Promise<T>) => {
  const connection = await activeScalableConnection(context.workspace.id);
  if (!connection) throw new Error("Scalable is not connected");
  return withScalable(connection.id, context.workspace.id, read);
};

async function lastSync(context: Context) {
  const { data, error } = await context.supabase.from("scalable_connections").select("last_synced_at, portfolio").eq("workspace_id", context.workspace.id)
    .in("status", ["active", "expired", "error"]).not("portfolio", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Scalable has not synced yet");
  return { syncedAt: data.last_synced_at as string | null, portfolio: data.portfolio as ScalablePortfolio };
}

const isLive = (context: Context) => context.settings.artifact_scalable_data === "live";
const percent = (gain: bigint, cost: bigint) => cost > 0n ? Number(gain * 10000n / cost) / 100 : null;

export async function scalablePortfolio(context: Context) {
  if (isLive(context)) {
    return { dataFrom: "live" as const, syncedAt: null, ...await live(context, mcp => investmentsPortfolio(mcp)) };
  }
  const { syncedAt, portfolio } = await lastSync(context);
  const ids = portfolio.itemIds ?? [];
  const { data, error } = ids.length ? await context.supabase.from("wealth_items").select("name, currency_code, amount_minor::text, quantity_text, unit_price_text, cost_basis_minor::text")
    .eq("workspace_id", context.workspace.id).eq("kind", "holding").is("removed_at", null).in("id", ids) : { data: [], error: null };
  if (error) throw error;
  const positions = (data ?? []).map(item => {
    const value = BigInt(item.amount_minor), cost = item.cost_basis_minor === null ? null : BigInt(item.cost_basis_minor);
    return { name: item.name, shares: item.quantity_text, currencyCode: item.currency_code, priceMinor: item.unit_price_text ? toMinor(item.unit_price_text, item.currency_code) : null,
      valueMinor: item.amount_minor, costMinor: item.cost_basis_minor, gainMinor: cost === null ? null : (value - cost).toString(), gainPercent: cost === null ? null : percent(value - cost, cost) };
  }).sort((a, b) => Number(BigInt(b.valueMinor) - BigInt(a.valueMinor)));
  return { dataFrom: "last_sync" as const, syncedAt, valuedAt: portfolio.valuedAt, currencyCode: portfolio.currency, totalMinor: portfolio.totalMinor,
    securitiesMinor: portfolio.securitiesMinor, cryptoMinor: portfolio.cryptoMinor, cashMinor: portfolio.cashMinor,
    returns: Object.keys(PERIODS).flatMap(timeframe => { const entry = portfolio.performance.find(item => item.timeframe === timeframe);
      return entry ? [{ period: PERIODS[timeframe], returnMinor: entry.returnMinor }] : []; }),
    positions };
}

export async function scalableActivity(context: Context) {
  if (isLive(context)) return { dataFrom: "live" as const, syncedAt: null, items: (await live(context, mcp => investmentsTransactions(mcp, { limit: 20 }))).transactions };
  const { syncedAt, portfolio } = await lastSync(context);
  return { dataFrom: "last_sync" as const, syncedAt, items: portfolio.activity ?? [] };
}

export async function scalableWatchlist(context: Context) {
  if (isLive(context)) {
    const { items } = await live(context, mcp => investmentsWatchlist(mcp));
    return { dataFrom: "live" as const, syncedAt: null, items: items.map(item => ({ isin: item.isin, name: item.name, priceMinor: item.quote?.priceMinor ?? null, currencyCode: item.quote?.currencyCode ?? "EUR", dayPercent: item.dayPercent })) };
  }
  const { syncedAt, portfolio } = await lastSync(context);
  return { dataFrom: "last_sync" as const, syncedAt, items: portfolio.watchlist ?? [] };
}

/** Quotes, charts and news exist only live, so this source is offered only when Settings allows live Scalable data. */
export async function scalableSecurity(input: z.infer<typeof securityInput>, context: Context) {
  if (!isLive(context)) throw new Error("Live Scalable data is off in Settings");
  return { dataFrom: "live" as const, ...await live(context, mcp => investmentsSecurity(mcp, input)) as object };
}
