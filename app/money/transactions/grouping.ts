import type { TransactionGroup } from "./filters";

type GroupRow = { category_id: string | null; merchant_id: string | null; posted_on: string; amount_minor: string; currency_code: string };
export type GroupSummary = { count: number; totals: Record<string, string> };

/** Group identity for a row; "none" for missing category/merchant. */
export function groupKey(row: Pick<GroupRow, "category_id" | "merchant_id" | "posted_on">, by: TransactionGroup): string {
  if (by === "month") return row.posted_on.slice(0, 7);
  return (by === "category" ? row.category_id : row.merchant_id) ?? "none";
}

/** Exact per-currency subtotals per group (BigInt, never floats). */
export function summarizeGroups(rows: GroupRow[], by: TransactionGroup): Map<string, GroupSummary> {
  const groups = new Map<string, GroupSummary>();
  for (const row of rows) {
    const key = groupKey(row, by);
    const group = groups.get(key) ?? { count: 0, totals: {} };
    group.count += 1;
    group.totals[row.currency_code] = (BigInt(group.totals[row.currency_code] ?? "0") + BigInt(row.amount_minor)).toString();
    groups.set(key, group);
  }
  return groups;
}

/** Stable reorder so each group's rows sit together, groups in first-seen order. */
export function orderByGroup<T extends Parameters<typeof groupKey>[0]>(rows: T[], by: TransactionGroup): T[] {
  const order = new Map<string, number>();
  for (const row of rows) { const key = groupKey(row, by); if (!order.has(key)) order.set(key, order.size); }
  return rows.map((row, index) => ({ row, index, group: order.get(groupKey(row, by))! }))
    .sort((a, b) => a.group - b.group || a.index - b.index).map(item => item.row);
}
