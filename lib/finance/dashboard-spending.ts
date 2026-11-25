import { cache } from "react";
import { loadLoanPayoutIds } from "@/lib/finance/iou";
import type { Db } from "@/lib/database";
import { expenditurePosting, reportExpenditure, type ExpenditureRate } from "@/lib/finance/expenditure";
import { loadExpenditureRates } from "@/lib/finance/expenditure-rates";
import { allPages } from "@/lib/all-pages";

export type SpendingRow = Parameters<typeof expenditurePosting>[0] & { category_id: string | null; merchant_id: string | null };
type Total = { incomeMinor: bigint; spendingMinor: bigint; partial: boolean };

const day = (year: number, monthIndex: number, date: number) => new Date(Date.UTC(year, monthIndex, date)).toISOString().slice(0, 10);
const min = (a: string, b: string) => a < b ? a : b;
const MONTHS = 6;
const ROW_LIMIT = 50_000;

function total(rows: SpendingRow[], rates: ExpenditureRate[], currencyCode: string, from: string, to: string): Total {
  const report = reportExpenditure(rows.map(expenditurePosting), rates, { view: "base", currencyCode, from, to });
  return { incomeMinor: BigInt(report.availableTotals.incomeMinor), spendingMinor: BigInt(report.availableTotals.spendingMinor), partial: report.status === "incomplete" };
}

export function summarizeSpending(rows: SpendingRow[], rates: ExpenditureRate[], currencyCode: string, today: string) {
  const [year = NaN, month = NaN, date = NaN] = today.split("-").map(Number);
  const monthTotal = (offset: number) => {
    const from = day(year, month - 1 - offset, 1), to = min(day(year, month - offset, 0), today);
    return { month: from.slice(0, 7), from, to, ...total(rows, rates, currencyCode, from, to) };
  };
  const earlier = Array.from({ length: MONTHS - 1 }, (_, index) => monthTotal(MONTHS - 1 - index));
  const thisMonth = monthTotal(0);
  const trend = [...earlier, thisMonth];
  const lastFrom = day(year, month - 2, 1), lastTo = min(day(year, month - 2, date), day(year, month - 1, 0));
  const lastMonthToDate = { from: lastFrom, to: lastTo, ...total(rows, rates, currencyCode, lastFrom, lastTo) };
  const top = (key: "category_id" | "merchant_id", from: string, to: string, metric: "spendingMinor" | "incomeMinor" = "spendingMinor") => {
    const current = rows.filter(row => row.posted_on >= from && row.posted_on <= to);
    const groups = new Map<string | null, SpendingRow[]>();
    for (const row of current) {
      const group = groups.get(row[key]);
      if (group) group.push(row); else groups.set(row[key], [row]);
    }
    return [...groups].map(([id, subset]) => ({ id, ...total(subset, rates, currencyCode, from, to) }))
      .filter(group => group[metric] > 0n)
      .sort((a, b) => a[metric] === b[metric] ? 0 : a[metric] < b[metric] ? 1 : -1)
      .slice(0, 5);
  };
  const monthDetail = ({ month, from, to }: typeof thisMonth) => ({ month, from, to, categories: top("category_id", from, to), merchants: top("merchant_id", from, to),
    incomeCategories: top("category_id", from, to, "incomeMinor"), incomeMerchants: top("merchant_id", from, to, "incomeMinor") });
  const current = monthDetail(thisMonth);
  const months = [...earlier.map(monthDetail), current];
  const { categories, merchants } = current;
  return { currencyCode, trend, thisMonth, lastMonthToDate, months, categories, merchants };
}

export const loadHomeSpending = cache(async (db: Db, workspaceId: string, currencyCode: string, today: string) => {
  const [year = NaN, month = NaN] = today.split("-").map(Number);
  const from = day(year, month - MONTHS, 1);
  async function loadRows() {
    const rows = await allPages<SpendingRow>((start, end, count) => db.from("effective_transactions")
      .select("id, parent_transaction_id, account_id, posted_on, version, amount_minor::text, currency_code, status, kind, review_reasons, category_id, merchant_id", count ? { count } : undefined)
      .eq("workspace_id", workspaceId).gte("posted_on", from).lte("posted_on", today).order("id").range(start, end), 1000);
    if (rows.length > ROW_LIMIT) throw new Error("Spending history exceeds the Home summary limit");
    return rows;
  }
  const [rows, rates, loans] = await Promise.all([loadRows(), loadExpenditureRates(db, workspaceId, { currencyCode, from, to: today }), loadLoanPayoutIds(db, workspaceId)]);
  const summary = summarizeSpending(rows.map(row => loans.has(row.parent_transaction_id ?? row.id) ? { ...row, kind: "transfer" } : row), rates, currencyCode, today);
  async function names(table: "categories" | "merchants", groups: { id: string | null }[]) {
    const ids = groups.flatMap(group => group.id ? [group.id] : []);
    if (!ids.length) return new Map<string, string>();
    const { data, error } = await db.from(table).select("id, name").eq("workspace_id", workspaceId).in("id", ids);
    if (error) throw error;
    return new Map((data ?? []).map(row => [row.id as string, row.name as string]));
  }
  async function activity(): Promise<"in range" | "earlier" | "none"> {
    if (rows.length) return "in range";
    const { data, error } = await db.from("transactions").select("id").eq("workspace_id", workspaceId).limit(1);
    if (error) throw error;
    return data.length ? "earlier" : "none";
  }
  const [categoryNames, merchantNames, history] = await Promise.all([names("categories", summary.months.flatMap(m => [...m.categories, ...m.incomeCategories])), names("merchants", summary.months.flatMap(m => [...m.merchants, ...m.incomeMerchants])), activity()]);
  return { ...summary, categoryNames, merchantNames, history };
});
