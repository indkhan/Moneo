
export const TRANSACTION_SORTS = ["date-desc", "date-asc", "amount-desc", "amount-asc"] as const;

export type TransactionSort = (typeof TRANSACTION_SORTS)[number];

export const DEFAULT_SORT: TransactionSort = "date-desc";

export const SORT_ORDER: Record<TransactionSort, { column: "posted_on" | "amount_minor"; ascending: boolean }> = {
  "date-desc": { column: "posted_on", ascending: false },
  "date-asc": { column: "posted_on", ascending: true },
  "amount-desc": { column: "amount_minor", ascending: false },
  "amount-asc": { column: "amount_minor", ascending: true },
};

const TRANSACTION_GROUPS = ["category", "merchant", "month"] as const;
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
  page?: number;
  transactionId?: string;
  group?: TransactionGroup;
};

const UUID_PATTERN = /^[0-9a-f-]{36}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MINOR_PATTERN = /^-?\d+$/;

const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function validDate(value: string): boolean {
  return DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

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

export function normalizeTag(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const tag = raw.trim().toLowerCase();
  if (!tag || tag.length > 40) return undefined;
  return tag;
}

export function normalizeEventName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const eventName = raw.trim();
  if (!eventName || eventName.length > 120) return undefined;
  return eventName;
}

function parsePage(raw: string | undefined): number | undefined {
  if (!raw || !/^\d{1,6}$/.test(raw)) return undefined;
  const page = Number(raw);
  return page > 1 ? page : undefined;
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
  const page = parsePage(first(raw.page));

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
    ...(page ? { page } : {}),
    ...(transactionId && UUID_PATTERN.test(transactionId) ? { transactionId } : {}),
    ...(maxAmountMinor === undefined ? {} : { maxAmountMinor }),
    ...((TRANSACTION_GROUPS as readonly string[]).includes(group ?? "") ? { group: group as TransactionGroup } : {}),
  };
}

export function toggleSort(current: TransactionSort, column: "date" | "amount"): TransactionSort {
  if (column === "date") return current === "date-desc" ? "date-asc" : "date-desc";
  return current === "amount-desc" ? "amount-asc" : "amount-desc";
}

export function toQueryParams(
  filters: ParsedTransactionParams,
  options: { includePage?: boolean } = {},
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
  if (options.includePage && filters.page) params.set("page", String(filters.page));
  return params;
}
