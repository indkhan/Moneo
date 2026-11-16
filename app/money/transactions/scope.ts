import type { ParsedTransactionParams } from "./filters";

interface Filterable<Q> {
  eq(column: string, value: string): Q;
  neq(column: string, value: string): Q;
  gt(column: string, value: number | string): Q;
  gte(column: string, value: string): Q;
  lt(column: string, value: number | string): Q;
  lte(column: string, value: string): Q;
  ilike(column: string, pattern: string): Q;
  is(column: string, value: null): Q;
  contains(column: string, value: string[]): Q;
}

export const ledgerTable = (filters: ParsedTransactionParams): "transactions" => (filters.categoryId || filters.uncategorized ? "transaction_category_ledger" : "transactions") as "transactions";

export function scopeLedger<Q extends Filterable<Q>>(query: Q, filters: ParsedTransactionParams): Q {
  let q = query;
  if (filters.q) q = q.ilike("description", `%${filters.q.replace(/[%_]/g, "\\$&")}%`);
  if (filters.tag) q = q.contains("tags", [filters.tag]);
  if (filters.eventName) q = q.eq("event_name", filters.eventName);
  if (filters.from) q = q.gte("posted_on", filters.from);
  if (filters.to) q = q.lte("posted_on", filters.to);
  if (filters.accountId) q = q.eq("account_id", filters.accountId);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.kind) q = q.eq("kind", filters.kind);
  if (filters.direction && !filters.kind) q = q.neq("kind", "transfer");
  if (filters.direction === "income") q = q.gt("amount_minor", 0);
  else if (filters.direction === "outflow") q = q.lt("amount_minor", 0);
  if (filters.categoryId) q = q.eq("category_id", filters.categoryId);
  else if (filters.uncategorized) q = q.is("category_id", null);
  if (filters.merchantId) q = q.eq("merchant_id", filters.merchantId);
  else if (filters.merchantUnknown) q = q.is("merchant_id", null);
  if (filters.minAmountMinor !== undefined) q = q.gte("amount_minor", filters.minAmountMinor);
  if (filters.maxAmountMinor !== undefined) q = q.lte("amount_minor", filters.maxAmountMinor);
  return q;
}
