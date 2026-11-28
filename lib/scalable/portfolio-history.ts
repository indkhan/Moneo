import { dayRange, netWorth, netWorthSeries } from "@/lib/finance/net-worth";
import type { netWorthModel, NetWorthEvidence } from "@/lib/finance/net-worth-source";
import { transitOn } from "@/lib/finance/transit";
import type { ScalablePortfolio } from "./portfolio";

export function scalablePortfolioHistory({ evidence, model, portfolio, today, timeZone }: {
  evidence: NetWorthEvidence; model: ReturnType<typeof netWorthModel>; portfolio: ScalablePortfolio; today: string; timeZone: string;
}) {
  const knownIds = new Set([...(portfolio.knownItemIds ?? []), ...(portfolio.itemIds ?? [])]);
  const returned = model.windows.filter(window => window.kind === "returned");
  const withReturns = (date: string, value: bigint, currency: string) => value + (transitOn(returned, date).get(currency) ?? 0n);
  const valuations = model.valuations.filter(row => knownIds.has(row.item_id));
  const from = valuations.reduce((min, row) => row.as_of < min ? row.as_of : min, today);
  const synced = netWorthSeries({ dates: dayRange(from, today), timeZone, accountIds: new Set(), snapshots: [], valuations })
    .flatMap(point => { const value = netWorth(point).get(portfolio.currency); return value === undefined ? [] : [{ date: point.date, value: withReturns(point.date, value, portfolio.currency) }]; });
  const before = model.calculated.before;
  const calculated = before ? evidence.scalable.rows.filter(row => row.on_date < before && row.currency_code === portfolio.currency) : [];
  return {
    points: [...calculated.map(row => ({ date: row.on_date, value: withReturns(row.on_date, BigInt(row.total_minor), row.currency_code) })), ...synced],
    calculatedBefore: calculated.length ? before : null,
  };
}
