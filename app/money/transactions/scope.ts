import type { ParsedTransactionParams } from "./filters";

// ponytail: structural view of the PostgREST builder; the real generic types recurse too deep to constrain.
interface Filterable {
  eq(column: string, value: string): Filterable;
  gt(column: string, value: number | string): Filterable;
  gte(column: string, value: string): Filterable;
  lt(column: string, value: number | string): Filterable;
  lte(column: string, value: string): Filterable;
  ilike(column: string, pattern: string): Filterable;
  is(column: string, value: null): Filterable;
  contains(column: string, value: string[]): Filterable;
}

/** Split-aware source table: a category filter must match split allocations too. */
export const ledgerTable = (filters: ParsedTransactionParams) => filters.categoryId || filters.uncategorized ? "transaction_category_ledger" : "transactions";

/** Apply the validated ledger filters (not sort/cursor) to any ledger query. */
export function scopeLedger<Q>(query: Q, filters: ParsedTransactionParams): Q {
  let q = query as unknown as Filterable;
  if (filters.q) q = q.ilike("description", `%${filters.q.replace(/[%_]/g, "\\$&")}%`);
  if (filters.tag) q = q.contains("tags", [filters.tag]);
  if (filters.eventName) q = q.eq("event_name", filters.eventName);
  if (filters.from) q = q.gte("posted_on", filters.from);
  if (filters.to) q = q.lte("posted_on", filters.to);
  if (filters.accountId) q = q.eq("account_id", filters.accountId);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.kind) q = q.eq("kind", filters.kind);
  if (filters.direction === "income") q = q.gt("amount_minor", 0);
  else if (filters.direction === "outflow") q = q.lt("amount_minor", 0);
  if (filters.categoryId) q = q.eq("category_id", filters.categoryId);
  else if (filters.uncategorized) q = q.is("category_id", null);
  if (filters.merchantId) q = q.eq("merchant_id", filters.merchantId);
  else if (filters.merchantUnknown) q = q.is("merchant_id", null);
  if (filters.minAmountMinor !== undefined) q = q.gte("amount_minor", filters.minAmountMinor);
  if (filters.maxAmountMinor !== undefined) q = q.lte("amount_minor", filters.maxAmountMinor);
  return q as unknown as Q;
}
