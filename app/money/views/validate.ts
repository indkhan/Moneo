// Validation for minimal saved transaction views (prompt.md §7).
//
// Only the allowlisted keys below are ever stored in
// public.transaction_views.filters (q/from/to/account/status/kind/
// direction/category/merchant/tag/event/amount range/sort). Cursor and
// open-transaction ids are never stored. Opening a view uses the opaque
// row UUID (?view=<uuid>)
// loaded server-side, so search terms and account/category/merchant UUIDs
// stay in workspace-scoped storage and never appear in the saved-view link.

import { DEFAULT_SORT, TRANSACTION_SORTS, parseMinorUnits, type TransactionSort } from "../transactions/filters";

export type SavedViewFilters = {
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
  /** Single tag, normalized like the live query and bulk tagging (trimmed, lowercase, ≤40 chars). */
  tag?: string;
  /** Spending-group identity, matched exactly (trimmed, case preserved, ≤120 chars). */
  eventName?: string;
  minAmountMinor?: string;
  maxAmountMinor?: string;
  sort?: TransactionSort;
};

const UUID_PATTERN = /^[0-9a-f-]{36}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  return DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function cleanText(value: string | undefined | null, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed ? trimmed : undefined;
}

/** Opaque view id from the URL (?view=<uuid>). Null when missing/invalid. */
export function parseViewId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed : null;
}

/** View name for the save form. Null when empty or over 80 chars. */
export function parseViewName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 80) return null;
  return trimmed;
}

export type SaveInput = {
  q?: string;
  from?: string;
  to?: string;
  account?: string;
  status?: string;
  kind?: string;
  direction?: string;
  category?: string;
  merchant?: string;
  tag?: string;
  event?: string;
  minAmount?: string;
  maxAmount?: string;
  sort?: string;
};

/**
 * Tolerant tag normalizer shared by the live URL path and the saved-view
 * loader. Returns the stored form (trimmed, lowercase) or undefined when
 * empty/invalid. The strict save path throws on invalid instead.
 */
export function normalizeTag(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const tag = raw.trim().toLowerCase();
  if (!tag || tag.length > 40) return undefined;
  return tag;
}

/**
 * Tolerant spending-group normalizer. Identity is the trimmed text with
 * case preserved (exact `event_name` match), or undefined when
 * empty/invalid.
 */
export function normalizeEventName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const eventName = raw.trim();
  if (!eventName || eventName.length > 120) return undefined;
  return eventName;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Strict builder for the save path. Throws on any provided but invalid
 * value so a mistyped filter is never silently dropped. Empty means omit.
 */
export function buildSavedFilters(input: SaveInput): SavedViewFilters {
  const filters: SavedViewFilters = {};

  const q = cleanText(input.q, 200);
  if (q) filters.q = q;

  const from = emptyToUndefined(input.from);
  if (from !== undefined) {
    if (!validDate(from)) throw new Error("Invalid from date");
    filters.from = from;
  }
  const to = emptyToUndefined(input.to);
  if (to !== undefined) {
    if (!validDate(to)) throw new Error("Invalid to date");
    filters.to = to;
  }

  const account = emptyToUndefined(input.account);
  if (account !== undefined) {
    if (!UUID_PATTERN.test(account)) throw new Error("Invalid account");
    filters.accountId = account;
  }

  const status = emptyToUndefined(input.status);
  if (status !== undefined) {
    if (status !== "posted" && status !== "pending") throw new Error("Invalid status");
    filters.status = status;
  }
  const kind = emptyToUndefined(input.kind);
  if (kind !== undefined) {
    if (kind !== "ordinary" && kind !== "transfer" && kind !== "refund") throw new Error("Invalid type");
    filters.kind = kind;
  }
  const direction = emptyToUndefined(input.direction);
  if (direction !== undefined) {
    if (direction !== "income" && direction !== "outflow") throw new Error("Invalid direction");
    filters.direction = direction;
  }

  const category = emptyToUndefined(input.category);
  if (category !== undefined) {
    if (category === "none") filters.uncategorized = true;
    else if (UUID_PATTERN.test(category)) filters.categoryId = category;
    else throw new Error("Invalid category");
  }

  const merchant = emptyToUndefined(input.merchant);
  if (merchant !== undefined) {
    if (merchant === "none") filters.merchantUnknown = true;
    else if (UUID_PATTERN.test(merchant)) filters.merchantId = merchant;
    else throw new Error("Invalid merchant");
  }

  const tag = emptyToUndefined(input.tag);
  if (tag !== undefined) {
    const normalized = normalizeTag(tag);
    if (normalized === undefined) throw new Error("Invalid tag");
    filters.tag = normalized;
  }

  const event = emptyToUndefined(input.event);
  if (event !== undefined) {
    const normalized = normalizeEventName(event);
    if (normalized === undefined) throw new Error("Invalid event");
    filters.eventName = normalized;
  }

  const minAmount = emptyToUndefined(input.minAmount);
  if (minAmount !== undefined) {
    const parsed = parseMinorUnits(minAmount);
    if (parsed === undefined) throw new Error("Invalid minimum amount");
    filters.minAmountMinor = parsed;
  }
  const maxAmount = emptyToUndefined(input.maxAmount);
  if (maxAmount !== undefined) {
    const parsed = parseMinorUnits(maxAmount);
    if (parsed === undefined) throw new Error("Invalid maximum amount");
    filters.maxAmountMinor = parsed;
  }

  const sort = emptyToUndefined(input.sort);
  if (sort !== undefined) {
    if (!(TRANSACTION_SORTS as readonly string[]).includes(sort)) throw new Error("Invalid sort");
    if (sort !== DEFAULT_SORT) filters.sort = sort as TransactionSort;
  }

  return filters;
}

/**
 * Actionable scope check for a persisted view. Returns an error message
 * when tag/event scope is present but invalid (e.g. oversized), so a saved
 * view is never silently broadened. Returns null when the stored scope is
 * usable; legacy rows without tag/event keys stay compatible (null).
 * Other fields keep the tolerant loader behavior below.
 */
export function invalidStoredViewScope(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "Saved view filters are invalid. Use current filters to repair this view, or delete it.";
  }
  const input = raw as Record<string, unknown>;
  if ("tag" in input && normalizeTag(input.tag) === undefined) {
    return "Saved view has an invalid tag filter. Use current filters to repair this view, or delete it.";
  }
  if ("eventName" in input && normalizeEventName(input.eventName) === undefined) {
    return "Saved view has an invalid spending-group filter. Use current filters to repair this view, or delete it.";
  }
  return null;
}

/**
 * Tolerant loader for the JSONB column. Never throws: unknown keys and
 * invalid values are dropped so one bad row can never break the browser.
 * Use invalidStoredViewScope first when a present-but-invalid tag/event
 * scope must surface instead of broadening.
 */
export function parseStoredFilters(raw: unknown): SavedViewFilters {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const filters: SavedViewFilters = {};

  if (typeof input.q === "string") {
    const q = input.q.trim().slice(0, 200);
    if (q) filters.q = q;
  }
  if (typeof input.from === "string" && validDate(input.from)) filters.from = input.from;
  if (typeof input.to === "string" && validDate(input.to)) filters.to = input.to;
  if (typeof input.accountId === "string" && UUID_PATTERN.test(input.accountId)) filters.accountId = input.accountId;
  if (input.status === "posted" || input.status === "pending") filters.status = input.status;
  if (input.kind === "ordinary" || input.kind === "transfer" || input.kind === "refund") filters.kind = input.kind;
  if (input.direction === "income" || input.direction === "outflow") filters.direction = input.direction;
  if (input.uncategorized === true) {
    filters.uncategorized = true;
  } else if (typeof input.categoryId === "string" && UUID_PATTERN.test(input.categoryId)) {
    filters.categoryId = input.categoryId;
  }
  if (input.merchantUnknown === true) {
    filters.merchantUnknown = true;
  } else if (typeof input.merchantId === "string" && UUID_PATTERN.test(input.merchantId)) {
    filters.merchantId = input.merchantId;
  }
  const storedTag = normalizeTag(input.tag);
  if (storedTag) filters.tag = storedTag;
  const storedEvent = normalizeEventName(input.eventName);
  if (storedEvent) filters.eventName = storedEvent;
  if (typeof input.minAmountMinor === "string" && parseMinorUnits(input.minAmountMinor) !== undefined) {
    filters.minAmountMinor = parseMinorUnits(input.minAmountMinor);
  }
  if (typeof input.maxAmountMinor === "string" && parseMinorUnits(input.maxAmountMinor) !== undefined) {
    filters.maxAmountMinor = parseMinorUnits(input.maxAmountMinor);
  }
  if (typeof input.sort === "string" && (TRANSACTION_SORTS as readonly string[]).includes(input.sort)) {
    if (input.sort !== DEFAULT_SORT) filters.sort = input.sort as TransactionSort;
  }
  return filters;
}
