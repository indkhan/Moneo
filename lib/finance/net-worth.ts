import { z } from "zod";
import type { ReadonlyDb } from "@/lib/database";
import { calendarDate } from "@/lib/finance/calendar";
import type { WealthItem } from "@/lib/finance/wealth";
import { coveredRows, latestSnapshotFirst, rowAgainstSnapshot, type BalanceSnapshot, type BalanceTransaction } from "@/lib/finance/balances";
import { transitOn, type TransitWindow } from "@/lib/finance/transit";

type Valuation = { item_id: string; created_at: string; kind: string; amount_minor: string; currency_code: string; as_of: string; linked_account_id: string | null; removed?: boolean };
type Snapshot = Omit<BalanceSnapshot, "provenance">;
type Posting = Omit<BalanceTransaction, "id"> & { id?: string };
export type NetWorthPoint = { date: string; accounts: Map<string, bigint>; assets: Map<string, bigint>; debts: Map<string, bigint>; transit: Map<string, bigint>; known: boolean; uncertain: string[]; accountValues?: Map<string, bigint> };
export type CalculatedValue = { on_date: string; currency_code: string; total_minor: string };

const add = (map: Map<string, bigint>, currency: string, amount: bigint) => map.set(currency, (map.get(currency) ?? 0n) + amount);

export function monthEndBefore(today: string, monthsBack: number): string {
  const [year = NaN, month = NaN] = today.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 - monthsBack, 0)).toISOString().slice(0, 10);
}

export function monthEnds(today: string, months: number): string[] {
  const dates = Array.from({ length: months }, (_, index) => monthEndBefore(today, months - 1 - index));
  return [...dates, today];
}

export function dayRange(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let time = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); time <= end; time += 86400000) dates.push(new Date(time).toISOString().slice(0, 10));
  return dates;
}

export function netWorthSeries({ dates, timeZone, accountIds, archivedOn, snapshots, valuations, ledger = [], calculated, transit = [] }: {
  dates: string[]; timeZone: string; accountIds: Set<string>; archivedOn?: Map<string, string>; snapshots: Snapshot[]; valuations: Valuation[]; ledger?: Posting[];
  calculated?: { rows: CalculatedValue[]; before: string | null }; transit?: TransitWindow[];
}): NetWorthPoint[] {
  const calculatedOn = new Map((calculated?.rows ?? []).map(row => [row.on_date, row]));
  const values = valuations.map(row => ({ key: row.item_id, date: row.as_of, at: row.created_at, amount: BigInt(row.amount_minor), currency: row.currency_code, debt: row.kind === "debt", counts: !row.linked_account_id && !row.removed }));
  const latestValues = (date: string) => {
    const pick = new Map<string, typeof values[number]>();
    for (const row of values) {
      if (row.date > date) continue;
      const prior = pick.get(row.key);
      if (!prior || row.date > prior.date || (row.date === prior.date && row.at >= prior.at)) pick.set(row.key, row);
    }
    return pick.values();
  };
  const dayCache = new Map<string, string>();
  const day = (at: string) => { let value = dayCache.get(at); if (value === undefined) { value = calendarDate(at, timeZone); dayCache.set(at, value); } return value; };
  const accounts = [...accountIds].map(id => {
    const rows = (ledger as BalanceTransaction[]).filter(row => row.account_id === id && row.status === "posted");
    const anchors = (snapshots as BalanceSnapshot[]).filter(row => row.account_id === id && !row.undone_at).sort(latestSnapshotFirst).map(snapshot => {
      const boundary = day(snapshot.as_of), observed = day(new Date(Date.parse(snapshot.as_of) - 1).toISOString()) === boundary;
      const read = rows.map(row => ({ row, posted: row.posted_at ? day(row.posted_at) : row.posted_on, amount: BigInt(row.amount_minor), side: "inside" as "inside" | "after", problem: null as string | null }));
      let problem: string | null = null, covered = new Set<string>();
      try { covered = coveredRows(snapshot, rows); } catch (error) { problem = error instanceof Error ? error.message : "This balance can't be proven"; }
      for (const item of read) {
        if (covered.has(item.row.id)) continue;
        try {
          item.side = rowAgainstSnapshot(item.row, item.posted, snapshot, boundary, observed);
          if (item.side === "after" && item.row.currency_code !== snapshot.currency_code) throw new Error("Ledger currency differs from account currency");
        } catch (error) { item.problem = error instanceof Error ? error.message : "This row can't be placed"; item.side = "inside"; }
      }
      return { snapshot, boundary, read, problem, amount: BigInt(snapshot.amount_minor) };
    });
    const firstPosted = rows.reduce<string | null>((first, row) => first === null || row.posted_on < first ? row.posted_on : first, null);
    return { id, anchors, firstPosted };
  });
  const hasAccountData = accounts.some(account => account.anchors.length > 0);
  const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return dates.map(date => {
    const point: NetWorthPoint = { date, accounts: new Map(), assets: new Map(), debts: new Map(), transit: new Map(), known: false, uncertain: [] };
    const counted = new Map<string, bigint>();
    for (const account of accounts) {
      const archived = archivedOn?.get(account.id);
      if (archived && date >= archived) continue;
      const anchor = account.anchors.find(item => item.boundary <= date);
      if (anchor) {
        let amount = anchor.amount;
        for (const item of anchor.read) if (item.posted <= date) {
          if (item.problem) point.uncertain.push(item.problem);
          if (item.side === "after") amount += item.amount;
        }
        if (anchor.problem) point.uncertain.push(anchor.problem);
        add(point.accounts, anchor.snapshot.currency_code, amount);
        counted.set(account.id, amount);
        continue;
      }
      if (!account.firstPosted || date < dayBefore(account.firstPosted)) continue;
      const next = [...account.anchors].reverse().find(item => item.boundary > date);
      if (!next) continue;
      let amount = next.amount;
      for (const item of next.read) if (item.posted > date && item.side === "inside") amount -= item.amount;
      if (next.problem) point.uncertain.push(next.problem);
      add(point.accounts, next.snapshot.currency_code, amount);
      counted.set(account.id, amount);
    }
    for (const row of latestValues(date)) if (row.counts) add(row.debt ? point.debts : point.assets, row.currency, row.amount);
    point.known = hasAccountData ? point.accounts.size > 0 : point.assets.size + point.debts.size > 0;
    const before = calculated?.before ?? null;
    const portfolio = point.known && before && date < before ? calculatedOn.get(date) : undefined;
    if (portfolio) add(point.assets, portfolio.currency_code, BigInt(portfolio.total_minor));
    const brokerShows = !!before && (date >= before || !!portfolio);
    if (point.known) point.transit = transitOn(transit, date, window => (!window.broker || brokerShows) && window.accounts.every(id => counted.has(id)));
    point.uncertain = [...new Set(point.uncertain)];
    point.accountValues = counted;
    return point;
  });
}

export function currentNetWorth(date: string, accounts: { currency_code: string; balance: { amount_minor: string | null } }[],
  valuations: { amountMinor: bigint; currencyCode: string; debt: boolean }[], transit: Map<string, bigint> = new Map()): NetWorthPoint {
  const point: NetWorthPoint = { date, accounts: new Map(), assets: new Map(), debts: new Map(), transit, known: false, uncertain: [] };
  for (const account of accounts) if (account.balance.amount_minor !== null) add(point.accounts, account.currency_code, BigInt(account.balance.amount_minor));
  for (const valuation of valuations) add(valuation.debt ? point.debts : point.assets, valuation.currencyCode, valuation.amountMinor);
  point.known = point.accounts.size + point.assets.size + point.debts.size > 0;
  return point;
}

export function netWorth(point: NetWorthPoint): Map<string, bigint> {
  const total = new Map<string, bigint>();
  for (const map of [point.accounts, point.assets, point.debts, point.transit]) for (const [currency, amount] of map) add(total, currency, amount);
  return total;
}

type WealthEvent = { id: string; item_id: string; before: WealthItem | null; after: WealthItem; created_at: string; undone_at: string | null };

export async function loadWealthEvents(db: ReadonlyDb, workspaceId: string): Promise<WealthEvent[]> {
  const rows: WealthEvent[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from("wealth_events").select("id, item_id, before, after, created_at, undone_at").eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false }).order("id").range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data ?? []) as WealthEvent[]);
    if (!data || data.length < 1000) return rows;
  }
}

export function valuationHistory(events: WealthEvent[], items: WealthItem[], timeZone: string): Valuation[] {
  return [...events.filter(event => !event.undone_at).map(event => ({ ...event.after, item_id: event.item_id, created_at: event.created_at, amount_minor: String(event.after.amount_minor),
    removed: !!event.after.removed_at, as_of: event.after.removed_at ? calendarDate(event.after.removed_at, timeZone) : event.after.as_of })),
    ...items.filter(item => !item.removed_at).map(item => ({ ...item, item_id: item.id, created_at: "9999-12-31", removed: false }))];
}

const portfolioItems = z.object({ knownItemIds: z.array(z.string()).optional(), itemIds: z.array(z.string()).optional() }).nullable().catch(null);

export const scalableKnownIds = (portfolios: ({ knownItemIds?: string[]; itemIds?: string[] } | null)[]) =>
  new Set(portfolios.flatMap(portfolio => [...(portfolio?.knownItemIds ?? []), ...(portfolio?.itemIds ?? [])]));

export function firstSyncedOn(valuations: Valuation[], knownIds: Set<string>): string | null {
  return valuations.reduce<string | null>((first, row) => knownIds.has(row.item_id) && !row.removed && (first === null || row.as_of < first) ? row.as_of : first, null);
}

export async function loadScalableHistory(db: ReadonlyDb, workspaceId: string) {
  const rows: CalculatedValue[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from("scalable_value_history").select("on_date, currency_code, total_minor::text").eq("workspace_id", workspaceId).order("on_date").range(offset, offset + 999);
    if (error) throw error;
    rows.push(...data ?? []);
    if (!data || data.length < 1000) break;
  }
  const connections = await db.from("scalable_connections").select("portfolio").eq("workspace_id", workspaceId).not("portfolio", "is", null);
  if (connections.error) throw connections.error;
  return { rows, knownIds: scalableKnownIds((connections.data ?? []).map(row => portfolioItems.parse(row.portfolio))) };
}

export function firstRealValue(valuations: Valuation[], knownIds: Set<string>, before: string | null, currency: string) {
  if (!before) return null;
  const onDay = valuations.filter(row => knownIds.has(row.item_id) && !row.removed && row.as_of === before && row.currency_code === currency);
  if (!onDay.length) return null;
  const latest = new Map<string, Valuation>();
  for (const row of onDay) {
    const held = latest.get(row.item_id);
    if (!held || row.created_at >= held.created_at) latest.set(row.item_id, row);
  }
  return { date: before, minor: [...latest.values()].reduce((sum, row) => sum + BigInt(row.amount_minor), 0n) };
}

export const archiveDates = (accounts: { id: string; archived_at?: string | null }[], timeZone: string) =>
  new Map(accounts.flatMap(account => account.archived_at ? [[account.id, calendarDate(account.archived_at, timeZone)] as const] : []));
