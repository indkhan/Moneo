import type { SupabaseClient } from "@supabase/supabase-js";
import { calendarDate } from "@/lib/finance/calendar";
import type { WealthItem } from "@/lib/finance/wealth";

type Snapshot = { account_id: string; amount_minor: string | number; currency_code: string; as_of: string; undone_at?: string | null };
type Valuation = { item_id: string; created_at: string; kind: string; amount_minor: string; currency_code: string; as_of: string; linked_account_id: string | null };
type NetWorthPoint = { date: string; accounts: Map<string, bigint>; assets: Map<string, bigint>; debts: Map<string, bigint> };

const add = (map: Map<string, bigint>, currency: string, amount: bigint) => map.set(currency, (map.get(currency) ?? 0n) + amount);

// Month ends for the last `months` months, then today.
export function monthEnds(today: string, months: number): string[] {
  const [year, month] = today.split("-").map(Number);
  const dates = Array.from({ length: months }, (_, index) => new Date(Date.UTC(year, month - 1 - (months - 1 - index), 0)).toISOString().slice(0, 10));
  return [...dates, today];
}

// Recorded net worth on each date: the latest recorded account balance and the latest standalone
// valuation dated on or before it. No FX and no interpolation; values carry forward until re-recorded.
// ponytail: archived accounts are left out (matching Home); include them if history must show closed accounts.
export function netWorthSeries({ dates, timeZone, accountIds, snapshots, valuations, removedOn }: {
  dates: string[]; timeZone: string; accountIds: Set<string>; snapshots: Snapshot[]; valuations: Valuation[]; removedOn: Map<string, string>;
}): NetWorthPoint[] {
  const balances = snapshots.filter(row => !row.undone_at && accountIds.has(row.account_id))
    .map(row => ({ key: row.account_id, date: calendarDate(row.as_of, timeZone), at: row.as_of, amount: BigInt(row.amount_minor), currency: row.currency_code }));
  const values = valuations.filter(row => !row.linked_account_id)
    .map(row => ({ key: row.item_id, date: row.as_of, at: row.created_at, amount: BigInt(row.amount_minor), currency: row.currency_code, debt: row.kind === "debt" }));
  const latest = <T extends { key: string; date: string; at: string }>(rows: T[], date: string) => {
    const pick = new Map<string, T>();
    for (const row of rows) {
      if (row.date > date) continue;
      const prior = pick.get(row.key);
      if (!prior || row.date > prior.date || (row.date === prior.date && row.at >= prior.at)) pick.set(row.key, row);
    }
    return pick.values();
  };
  return dates.map(date => {
    const point: NetWorthPoint = { date, accounts: new Map(), assets: new Map(), debts: new Map() };
    for (const row of latest(balances, date)) add(point.accounts, row.currency, row.amount);
    for (const row of latest(values, date)) {
      const removed = removedOn.get(row.key);
      if (removed && removed <= date) continue;
      add(row.debt ? point.debts : point.assets, row.currency, row.amount);
    }
    return point;
  });
}

export function netWorth(point: NetWorthPoint): Map<string, bigint> {
  const total = new Map<string, bigint>();
  for (const map of [point.accounts, point.assets, point.debts]) for (const [currency, amount] of map) add(total, currency, amount);
  return total;
}

type WealthEvent = { id: string; item_id: string; before: WealthItem | null; after: WealthItem; created_at: string; undone_at: string | null };

/** Every saved valuation event (newest first), paged; the Wealth page lists them and both it and Home chart them. */
export async function loadWealthEvents(db: SupabaseClient, workspaceId: string): Promise<WealthEvent[]> {
  const rows: WealthEvent[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from("wealth_events").select("id, item_id, before, after, created_at, undone_at").eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false }).order("id").range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data ?? []) as WealthEvent[]);
    if (!data || data.length < 1000) return rows;
  }
}

// Valuation history = every non-undone saved version of each item, plus the current row.
export function valuationHistory(events: WealthEvent[], items: WealthItem[]): Valuation[] {
  return [...events.filter(event => !event.undone_at && !event.after.removed_at).map(event => ({ ...event.after, item_id: event.item_id, created_at: event.created_at, amount_minor: String(event.after.amount_minor) })),
    ...items.map(item => ({ ...item, item_id: item.id, created_at: "9999-12-31" }))];
}

export const removedOn = (items: WealthItem[], timeZone: string) => new Map(items.filter(item => item.removed_at).map(item => [item.id, calendarDate(item.removed_at!, timeZone)]));
