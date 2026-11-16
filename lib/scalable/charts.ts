import { z } from "zod";
import { serviceDb } from "@/lib/service-db";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScalableMcp } from "./client";
import type { HistoryRow } from "./history";
import { decimalText } from "./portfolio";

export const CHART_PERIODS = [["one_day", "1D"], ["seven_days", "1W"], ["one_month", "1M"], ["one_year", "1Y"], ["max", "Max"]] as const;
export type ChartTimeframe = (typeof CHART_PERIODS)[number][0];
export type ChartPoint = { at: string; price: string };
export type ChartRow = { isin: string; timeframe: ChartTimeframe; currency_code: string; points: ChartPoint[]; fetched_at: string };
export type TradeRow = { provider_id: string; isin: string; side: "BUY" | "SELL"; occurred_at: string; quantity_text: string };
export type PositionChart = { periods: { timeframe: ChartTimeframe; label: string; currency: string; points: ChartPoint[]; fetchedAt: string }[]; trades: { at: string; side: "BUY" | "SELL"; quantity: string }[] };

const MAX_POINTS = 240, CONCURRENCY = 4;
const decimal = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/)]);
const decimalString = /^[0-9]+(\.[0-9]+)?$/;
const text = (value: number | string) => typeof value === "number" ? decimalText(value) : value.replace(/^-/, "");
const chartSchema = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), dataPoints: z.array(z.object({ midPrice: decimal.nullish(), timestampUtc: z.string() })).default([]) });
const storedPoints = z.array(z.object({ at: z.string(), price: z.string().regex(decimalString) }));
const listSchema = z.object({ transactions: z.array(z.object({ id: z.string().min(1), status: z.string(), isCancellation: z.boolean().nullish(), lastEventAt: z.string(),
  security: z.object({ isin: z.string(), side: z.string().nullish(), quantity: decimal.nullish() }).nullish() })).default([]) });

export function thinned<T>(points: T[], limit = MAX_POINTS): T[] {
  if (points.length <= limit) return points;
  return Array.from({ length: limit }, (_, index) => points[Math.round(index * (points.length - 1) / (limit - 1))]);
}

async function readChart(mcp: Pick<ScalableMcp, "callTool">, isin: string, timeframe: ChartTimeframe, fetchedAt: string): Promise<ChartRow | null> {
  const chart = chartSchema.parse(await mcp.callTool("get_security_chart", { isin, timeframe }));
  const points = new Map(chart.dataPoints.flatMap(point => point.midPrice != null && Number(point.midPrice) > 0 && !Number.isNaN(Date.parse(point.timestampUtc))
    ? [[new Date(point.timestampUtc).toISOString(), text(point.midPrice)] as const] : []));
  if (!points.size) return null;
  return { isin, timeframe, currency_code: chart.currency, fetched_at: fetchedAt,
    points: thinned([...points].sort(([a], [b]) => Date.parse(a) - Date.parse(b)).map(([at, price]) => ({ at, price }))) };
}

export async function readCharts(mcp: Pick<ScalableMcp, "callTool">, isins: string[], fetchedAt: string) {
  const jobs = isins.flatMap(isin => CHART_PERIODS.map(([timeframe]) => ({ isin, timeframe })));
  const rows: ChartRow[] = [];
  let failed = 0, next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try { const row = await readChart(mcp, job.isin, job.timeframe, fetchedAt); if (row) rows.push(row); } catch { failed++; }
    }
  }));
  return { rows, failed };
}

export function tradeRows(reply: unknown): TradeRow[] {
  return listSchema.parse(reply).transactions.flatMap(row => {
    const side = row.security?.side?.toUpperCase(), quantity = row.security?.quantity == null ? null : text(row.security.quantity);
    if (row.status !== "SETTLED" || row.isCancellation || (side !== "BUY" && side !== "SELL") || !quantity || !decimalString.test(quantity) || Number(quantity) <= 0) return [];
    return [{ provider_id: row.id, isin: row.security!.isin, side, occurred_at: row.lastEventAt, quantity_text: quantity }];
  });
}

export function historyTradeRows(rows: HistoryRow[]): TradeRow[] {
  return rows.flatMap(row => {
    const quantity = row.kind === "security" ? row.quantity?.replace(/^-/, "") : undefined;
    return row.kind === "security" && (row.side === "BUY" || row.side === "SELL") && quantity && decimalString.test(quantity) && Number(quantity) > 0
      ? [{ provider_id: row.id, isin: row.isin, side: row.side, occurred_at: row.at, quantity_text: quantity }] : [];
  });
}

export async function saveCharts(connectionId: string, saved: { charts: ChartRow[]; trades: TradeRow[]; held: string[] | null }) {
  const { error } = await serviceDb().rpc("save_scalable_charts", { p_connection_id: connectionId, p_charts: saved.charts, p_trades: saved.trades, p_held: saved.held });
  if (error) throw new Error(error.message);
}

export async function removeCharts(workspaceId: string) {
  const { error } = await serviceDb().rpc("remove_scalable_charts", { p_workspace_id: workspaceId });
  if (error) throw new Error(error.message);
}

export async function chartedIsins(db: SupabaseClient, workspaceId: string) {
  const { data, error } = await db.from("scalable_security_charts").select("isin").eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map(row => row.isin as string));
}

export async function loadPositionChart(db: SupabaseClient, workspaceId: string, isin: string): Promise<PositionChart> {
  const [charts, trades] = await Promise.all([
    db.from("scalable_security_charts").select("timeframe, currency_code, points, fetched_at").eq("workspace_id", workspaceId).eq("isin", isin),
    db.from("scalable_security_trades").select("side, occurred_at, quantity_text").eq("workspace_id", workspaceId).eq("isin", isin).order("occurred_at"),
  ]);
  for (const result of [charts, trades]) if (result.error) throw new Error(result.error.message);
  return {
    periods: CHART_PERIODS.flatMap(([timeframe, label]) => {
      const row = (charts.data ?? []).find(entry => entry.timeframe === timeframe);
      const points = row ? storedPoints.safeParse(row.points) : null;
      return row && points?.success && points.data.length ? [{ timeframe, label, currency: row.currency_code as string, points: points.data, fetchedAt: row.fetched_at as string }] : [];
    }),
    trades: (trades.data ?? []).map(row => ({ at: row.occurred_at as string, side: row.side as "BUY" | "SELL", quantity: row.quantity_text as string })),
  };
}
