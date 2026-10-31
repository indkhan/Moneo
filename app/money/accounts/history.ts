import type { BalanceSnapshot, resolveBalances } from "@/lib/finance/balances";

// The one number to show per account, with an honest label for how it was derived.
export function shownBalance(balance: ReturnType<typeof resolveBalances>[number]["balance"]) {
  if (balance.status === "current") return { amount: balance.amount_minor, label: balance.unconfirmed_rows ? "Unconfirmed" : "Current" };
  if (balance.status === "stale") return { amount: balance.estimated_amount_minor, label: "Estimated" };
  if (balance.status === "ambiguous") return { amount: balance.snapshot_amount_minor, label: "Needs review" };
  return { amount: null, label: "No balance yet" };
}
import { calendarDate } from "@/lib/finance/calendar";
import type { Point } from "./sparkline";

// Recorded (non-undone) balances, last one per calendar day, from `from` onward plus the
// last observation before it so the line starts at a real value. Optional `current` caps it.
export function balanceTrend(snapshots: BalanceSnapshot[], accountId: string, currency: string, timeZone: string, from: string, current?: Point): Point[] {
  const byDay = new Map<string, { at: number; value: bigint }>();
  for (const row of snapshots) {
    if (row.account_id !== accountId || row.undone_at || row.currency_code !== currency) continue;
    const at = Date.parse(row.as_of);
    if (!Number.isFinite(at)) continue;
    const day = calendarDate(row.as_of, timeZone);
    const prior = byDay.get(day);
    if (!prior || at >= prior.at) byDay.set(day, { at, value: BigInt(row.amount_minor) });
  }
  const days = [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, { value }]) => ({ date, value }));
  const start = days.findIndex(point => point.date >= from);
  const points = start === -1 ? days.slice(-1) : days.slice(Math.max(0, start - 1));
  if (current && (!points.length || points.at(-1)!.date < current.date)) points.push(current);
  else if (current && points.at(-1)!.date === current.date) points[points.length - 1] = current;
  return points;
}
