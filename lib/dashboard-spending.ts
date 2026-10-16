import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expenditurePosting, reportExpenditure, type ExpenditureRate } from "@/lib/finance/expenditure";
import { loadExpenditureRates } from "@/lib/finance/expenditure-rates";

export type SpendingRow = Parameters<typeof expenditurePosting>[0] & { category_id: string | null; merchant_id: string | null };
type Total = { spendingMinor: bigint; partial: boolean };

const day = (year: number, monthIndex: number, date: number) => new Date(Date.UTC(year, monthIndex, date)).toISOString().slice(0, 10);
const min = (a: string, b: string) => a < b ? a : b;
const MONTHS = 6;
const ROW_LIMIT = 50_000;

// Totals come from reportExpenditure (exact-date FX, refunds subtracted, pending,
// transfers and review rows excluded). `partial` marks a total missing some rows.
function total(rows: SpendingRow[], rates: ExpenditureRate[], currencyCode: string, from: string, to: string): Total {
  const report = reportExpenditure(rows.map(expenditurePosting), rates, { view: "base", currencyCode, from, to });
  return { spendingMinor: BigInt(report.availableTotals.spendingMinor), partial: report.status === "incomplete" };
}

export function summarizeSpending(rows: SpendingRow[], rates: ExpenditureRate[], currencyCode: string, today: string) {
  const [year, month, date] = today.split("-").map(Number);
  const trend = Array.from({ length: MONTHS }, (_, index) => {
    const offset = MONTHS - 1 - index;
    const from = day(year, month - 1 - offset, 1), to = min(day(year, month - offset, 0), today);
    return { month: from.slice(0, 7), from, to, ...total(rows, rates, currencyCode, from, to) };
  });
  const thisMonth = trend[MONTHS - 1];
  // Same number of days into last month, clamped to its end (31 Mar compares with 28/29 Feb).
  const lastFrom = day(year, month - 2, 1), lastTo = min(day(year, month - 2, date), day(year, month - 1, 0));
  const lastMonthToDate = { from: lastFrom, to: lastTo, ...total(rows, rates, currencyCode, lastFrom, lastTo) };
  const current = rows.filter(row => row.posted_on >= thisMonth.from && row.posted_on <= today);
  const top = (key: "category_id" | "merchant_id") => {
    const groups = new Map<string | null, SpendingRow[]>();
    for (const row of current) {
      const group = groups.get(row[key]);
      if (group) group.push(row); else groups.set(row[key], [row]);
    }
    return [...groups].map(([id, subset]) => ({ id, ...total(subset, rates, currencyCode, thisMonth.from, today) }))
      .filter(group => group.spendingMinor > 0n)
      .sort((a, b) => a.spendingMinor === b.spendingMinor ? 0 : a.spendingMinor < b.spendingMinor ? 1 : -1)
      .slice(0, 5);
  };
  return { currencyCode, trend, thisMonth, lastMonthToDate, categories: top("category_id"), merchants: top("merchant_id") };
}

// One read of the last six months feeds the KPI tile, trend chart and top lists; memoized per request.
export const loadHomeSpending = cache(async (db: SupabaseClient, workspaceId: string, currencyCode: string, today: string) => {
  const [year, month] = today.split("-").map(Number);
  const from = day(year, month - MONTHS, 1);
  async function loadRows() {
    const rows: SpendingRow[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.from("effective_transactions")
        .select("id, parent_transaction_id, account_id, posted_on, version, amount_minor::text, currency_code, status, kind, review_reasons, category_id, merchant_id")
        .eq("workspace_id", workspaceId).gte("posted_on", from).lte("posted_on", today).order("id").range(offset, offset + 999);
      if (error) throw error;
      rows.push(...(data ?? []) as unknown as SpendingRow[]);
      if (rows.length > ROW_LIMIT) throw new Error("Spending history exceeds the Home summary limit");
      if (!data || data.length < 1000) return rows;
    }
  }
  const [rows, rates] = await Promise.all([loadRows(), loadExpenditureRates(db, workspaceId, { currencyCode, from, to: today })]);
  const summary = summarizeSpending(rows, rates, currencyCode, today);
  async function names(table: "categories" | "merchants", groups: { id: string | null }[]) {
    const ids = groups.flatMap(group => group.id ? [group.id] : []);
    if (!ids.length) return new Map<string, string>();
    const { data, error } = await db.from(table).select("id, name").eq("workspace_id", workspaceId).in("id", ids);
    if (error) throw error;
    return new Map((data ?? []).map(row => [row.id as string, row.name as string]));
  }
  const [categoryNames, merchantNames] = await Promise.all([names("categories", summary.categories), names("merchants", summary.merchants)]);
  return { ...summary, categoryNames, merchantNames };
});
