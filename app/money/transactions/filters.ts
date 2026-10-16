// Helpers for the Money → Transactions browser.
//
// URL params stay validated and sort columns stay on a fixed allowlist so a
// crafted query string can never inject an arbitrary column into the
// Supabase query. Amounts are exact minor-unit integer strings (never
// floats) validated against the Postgres bigint range.

export const TRANSACTION_SORTS = ["date-desc", "date-asc", "amount-desc", "amount-asc"] as const;

export type TransactionSort = (typeof TRANSACTION_SORTS)[number];

export const DEFAULT_SORT: TransactionSort = "date-desc";

export const SORT_ORDER: Record<TransactionSort, { column: "posted_on" | "amount_minor"; ascending: boolean }> = {
  "date-desc": { column: "posted_on", ascending: false },
  "date-asc": { column: "posted_on", ascending: true },
  "amount-desc": { column: "amount_minor", ascending: false },
  "amount-asc": { column: "amount_minor", ascending: true },
};

export const TRANSACTION_GROUPS = ["category", "merchant", "month"] as const;
export type TransactionGroup = (typeof TRANSACTION_GROUPS)[number];

export type ParsedTransactionParams = {
  q?: string;
  from?: string;
  to?: string;
  accountId?: string;
  status?: "posted" | "pending";
  kind?: "ordinary" | "transfer" | "refund";
  direction?: "income" | "outflow";
  categoryId?: string;
  uncategorized?: boolean;
  merchantId?: string;
  merchantUnknown?: boolean;
  tag?: string;
  eventName?: string;
  minAmountMinor?: string;
  maxAmountMinor?: string;
  sort: TransactionSort;
  cursor?: { value: string; id: string };
  transactionId?: string;
  /** Display-only grouping; never stored in saved views. */
  group?: TransactionGroup;
};

const UUID_PATTERN = /^[0-9a-f-]{36}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MINOR_PATTERN = /^-?\d+$/;

// Postgres bigint range; amounts outside this would error in the database.
const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function validDate(value: string): boolean {
  return DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Canonicalize an exact minor-unit integer string, or undefined if invalid. */
export function parseMinorUnits(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!MINOR_PATTERN.test(trimmed)) return undefined;
  try {
    const value = BigInt(trimmed);
    if (value < BIGINT_MIN || value > BIGINT_MAX) return undefined;
    return value.toString();
  } catch {
    return undefined;
  }
}

/** Stored tag form (trimmed, lowercase, 1–40 chars), matching bulk tagging. */
export function normalizeTag(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const tag = raw.trim().toLowerCase();
  if (!tag || tag.length > 40) return undefined;
  return tag;
}

/** Spending-group identity: trimmed, case preserved, 1–120 chars (exact `event_name` match). */
export function normalizeEventName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const eventName = raw.trim();
  if (!eventName || eventName.length > 120) return undefined;
  return eventName;
}

function parseCursor(raw: string | undefined, sort: TransactionSort): ParsedTransactionParams["cursor"] {
  const text = first(raw);
  if (!text) return undefined;
  const separator = text.indexOf("|");
  if (separator < 0) return undefined;
  const value = text.slice(0, separator);
  const id = text.slice(separator + 1);
  if (!UUID_PATTERN.test(id)) return undefined;
  if (sort === "date-desc" || sort === "date-asc") {
    if (!validDate(value)) return undefined;
  } else {
    if (parseMinorUnits(value) === undefined) return undefined;
  }
  return { value, id };
}

export function parseTransactionParams(
  raw: Record<string, string | string[] | undefined>,
): ParsedTransactionParams {
  const sortRaw = first(raw.sort);
  const sort: TransactionSort = (TRANSACTION_SORTS as readonly string[]).includes(sortRaw ?? "")
    ? (sortRaw as TransactionSort)
    : DEFAULT_SORT;

  const q = first(raw.q)?.trim().slice(0, 200) || undefined;
  const from = first(raw.from);
  const to = first(raw.to);
  const accountId = first(raw.account);
  const status = first(raw.status);
  const kind = first(raw.kind);
  const direction = first(raw.direction);
  const category = first(raw.category);
  const merchant = first(raw.merchant);
  const tag = normalizeTag(first(raw.tag));
  const eventName = normalizeEventName(first(raw.event));
  const group = first(raw.group);
  const transactionId = first(raw.transaction);
  const minAmountMinor = parseMinorUnits(first(raw.minAmount));
  const maxAmountMinor = parseMinorUnits(first(raw.maxAmount));
  const cursor = parseCursor(first(raw.cursor) ?? undefined, sort);

  return {
    ...(q ? { q } : {}),
    ...(from && validDate(from) ? { from } : {}),
    ...(to && validDate(to) ? { to } : {}),
    ...(accountId && UUID_PATTERN.test(accountId) ? { accountId } : {}),
    ...(status === "posted" || status === "pending" ? { status } : {}),
    ...(kind === "ordinary" || kind === "transfer" || kind === "refund" ? { kind } : {}),
    ...(direction === "income" || direction === "outflow" ? { direction } : {}),
    ...(category === "none"
      ? { uncategorized: true }
      : category && UUID_PATTERN.test(category)
        ? { categoryId: category }
        : {}),
    ...(merchant === "none"
      ? { merchantUnknown: true }
      : merchant && UUID_PATTERN.test(merchant)
        ? { merchantId: merchant }
        : {}),
    ...(tag ? { tag } : {}),
    ...(eventName ? { eventName } : {}),
    ...(minAmountMinor === undefined ? {} : { minAmountMinor }),
    sort,
    ...(cursor ? { cursor } : {}),
    ...(transactionId && UUID_PATTERN.test(transactionId) ? { transactionId } : {}),
    ...(maxAmountMinor === undefined ? {} : { maxAmountMinor }),
    ...((TRANSACTION_GROUPS as readonly string[]).includes(group ?? "") ? { group: group as TransactionGroup } : {}),
  };
}

function isAmountSort(sort: TransactionSort): boolean {
  return sort === "amount-desc" || sort === "amount-asc";
}

/**
 * Keyset pagination predicate for a Supabase `.or()` call.
 * Inputs must come from parseTransactionParams, so interpolation is safe.
 */
export function cursorClause(sort: TransactionSort, cursor: { value: string; id: string }): string {
  const { column, ascending } = SORT_ORDER[sort];
  const op = ascending ? "gt" : "lt";
  return `${column}.${op}.${cursor.value},and(${column}.eq.${cursor.value},id.${op}.${cursor.id})`;
}

/** Encode the next-page cursor from the last row of the current page. */
export function nextCursorForRow(
  row: { posted_on: string; amount_minor: string; id: string },
  sort: TransactionSort,
): string {
  const value = isAmountSort(sort) ? BigInt(row.amount_minor).toString() : row.posted_on;
  return `${value}|${row.id}`;
}

/** Toggle helper for the Date / Amount column headers. */
export function toggleSort(current: TransactionSort, column: "date" | "amount"): TransactionSort {
  if (column === "date") return current === "date-desc" ? "date-asc" : "date-desc";
  return current === "amount-desc" ? "amount-asc" : "amount-desc";
}

/** Serialize filters back to shareable URL params (cursor dropped by default). */
export function toQueryParams(
  filters: ParsedTransactionParams,
  options: { includeCursor?: boolean } = {},
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.accountId) params.set("account", filters.accountId);
  if (filters.status) params.set("status", filters.status);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.direction) params.set("direction", filters.direction);
  if (filters.uncategorized) params.set("category", "none");
  else if (filters.categoryId) params.set("category", filters.categoryId);
  if (filters.merchantUnknown) params.set("merchant", "none");
  else if (filters.merchantId) params.set("merchant", filters.merchantId);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.eventName) params.set("event", filters.eventName);
  if (filters.minAmountMinor !== undefined) params.set("minAmount", filters.minAmountMinor);
  if (filters.maxAmountMinor !== undefined) params.set("maxAmount", filters.maxAmountMinor);
  if (filters.sort !== DEFAULT_SORT) params.set("sort", filters.sort);
  if (filters.group) params.set("group", filters.group);
  if (options.includeCursor && filters.cursor) params.set("cursor", `${filters.cursor.value}|${filters.cursor.id}`);
  return params;
}
