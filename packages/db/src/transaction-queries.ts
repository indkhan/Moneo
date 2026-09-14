import { createHmac, timingSafeEqual } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { DomainError } from "@moneo/shared/problem";
import type { Db } from "./client.js";
import { transactions, type Transaction, type TransactionDirection } from "./schema.js";
import type * as schema from "./schema.js";
import { assertUuid } from "./uuid.js";

/**
 * Issue 4.6 — cursor-based transaction search.
 *
 * One fixed keyset — `(effective_date, id)` — in two directions (`newest`
 * first by default, `oldest` on request). The `id` tiebreak (UUIDv7,
 * time-ordered) keeps pagination deterministic even when hundreds of rows
 * share one date, and keyset pages never skip or duplicate rows under
 * concurrent inserts the way OFFSET pages do.
 *
 * The cursor is opaque and tamper-evident: `base64url(payload).hex(hmac)`.
 * The payload binds the workspace, sort, and last-row position, so a cursor
 * minted for workspace A (or the opposite sort) is rejected in any other
 * context instead of leaking or misordering rows. Changing FILTERS starts a
 * new listing (`cursor: null`): the cursor carries position only, by design.
 *
 * Validation throws `DomainError(VALIDATION_FAILED)`; the web boundary maps
 * it onto the documented problem shape (Issue 2.3 codes).
 */

export type TransactionQueryDb = Db | PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

export type TransactionSort = "newest" | "oldest";

export interface TransactionSearchInput {
  categoryIds?: string[];
  tagNames?: string[];
  accountIds?: string[];
  dateFrom?: string;
  dateTo?: string;
  directions?: TransactionDirection[];
  /** Decimal-string integer minor units (exact-JSON convention). */
  amountMin?: string;
  amountMax?: string;
  /** Case-insensitive substring over the description. */
  text?: string;
  sort?: TransactionSort;
  limit?: number;
  /** Opaque cursor from a previous page, or null to start over. */
  cursor?: string | null;
}

export interface TransactionSearchPage {
  items: Transaction[];
  nextCursor: string | null;
}

interface CursorPayload {
  w: string;
  s: TransactionSort;
  d: string;
  i: string;
}

function fail(message: string): never {
  throw new DomainError("VALIDATION_FAILED", {
    detail: message,
    errors: [{ field: "search", message }],
  });
}

function checkDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail(`Invalid ${field} (expected YYYY-MM-DD): ${value}.`);
  }
  return value;
}

function checkAmount(value: string, field: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    fail(`Invalid ${field} (expected non-negative integer string): ${value}.`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    fail(`Invalid ${field} (exceeds safe integer range): ${value}.`);
  }
  return n;
}

function checkUuid(id: string, label: string): string {
  try {
    return assertUuid(id, label);
  } catch {
    fail(`Invalid ${label} (expected UUID): ${id}.`);
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** HMAC-bound opaque cursor codec. The secret stays server-side. */
export function createSearchCursorCodec(secret: string) {
  if (secret.length === 0) {
    fail("Cursor secret must be a non-empty string.");
  }
  const sign = (payload: string): string =>
    createHmac("sha256", secret).update(payload, "utf8").digest("hex");

  return {
    encode(payload: CursorPayload): string {
      const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      return `${body}.${sign(body)}`;
    },
    decode(token: string, expectedWorkspace: string): CursorPayload {
      const [body, signature] = token.split(".");
      if (!body || !signature) {
        fail("Invalid cursor (malformed).");
      }
      const expected = sign(body);
      const a = Buffer.from(signature, "utf8");
      const b = Buffer.from(expected, "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        fail("Invalid cursor (bad signature).");
      }
      // Untrusted bytes: parse as unknown and validate the shape field by
      // field — never trust the declared CursorPayload type here.
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
      } catch {
        fail("Invalid cursor (unreadable).");
      }
      const record = raw as Record<string, unknown>;
      if (
        typeof record["w"] !== "string" ||
        (record["s"] !== "newest" && record["s"] !== "oldest") ||
        typeof record["d"] !== "string" ||
        typeof record["i"] !== "string"
      ) {
        fail("Invalid cursor (unknown shape).");
      }
      const payload: CursorPayload = {
        w: record["w"],
        s: record["s"],
        d: record["d"],
        i: record["i"],
      };
      if (payload.w !== expectedWorkspace) {
        fail("Invalid cursor (wrong workspace).");
      }
      return payload;
    },
  };
}

export type SearchCursorCodec = ReturnType<typeof createSearchCursorCodec>;

export async function searchTransactions(
  db: TransactionQueryDb,
  workspaceId: string,
  input: TransactionSearchInput,
  codec: SearchCursorCodec,
): Promise<TransactionSearchPage> {
  checkUuid(workspaceId, "workspaceId");
  // `sort` arrives as untrusted input: validate as a plain string first so a
  // forged value fails closed instead of misordering the keyset.
  const requested: string = input.sort ?? "newest";
  if (requested !== "newest" && requested !== "oldest") {
    fail(`Invalid sort (expected newest|oldest): ${requested}.`);
  }
  const sort: TransactionSort = requested;
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));

  const conditions: SQL[] = [eq(transactions.workspaceId, workspaceId)];
  if (input.categoryIds?.length) {
    input.categoryIds.forEach((id) => checkUuid(id, "categoryId"));
    conditions.push(inArray(transactions.categoryId, input.categoryIds));
  }
  for (const name of input.tagNames ?? [])
    conditions.push(
      sql`exists (select 1 from transaction_tags tt join tags tag on tag.id=tt.tag_id and tag.workspace_id=tt.workspace_id where tt.workspace_id=${workspaceId} and tt.transaction_id=${transactions.id} and tag.name=${name})`,
    );

  if (input.accountIds !== undefined) {
    if (input.accountIds.length === 0) {
      return { items: [], nextCursor: null };
    }
    for (const id of input.accountIds) {
      checkUuid(id, "accountId");
    }
    conditions.push(inArray(transactions.accountId, [...new Set(input.accountIds)]));
  }
  if (input.dateFrom !== undefined) {
    conditions.push(gte(transactions.effectiveDate, checkDate(input.dateFrom, "dateFrom")));
  }
  if (input.dateTo !== undefined) {
    conditions.push(lte(transactions.effectiveDate, checkDate(input.dateTo, "dateTo")));
  }
  if (input.dateFrom !== undefined && input.dateTo !== undefined && input.dateFrom > input.dateTo) {
    fail(`Invalid range (dateFrom after dateTo): ${input.dateFrom} > ${input.dateTo}.`);
  }
  if (input.directions !== undefined) {
    // Runtime validation over plain strings: a forged direction fails closed.
    const directions: string[] = [...input.directions];
    for (const direction of directions) {
      if (direction !== "credit" && direction !== "debit") {
        fail(`Invalid direction: ${direction}.`);
      }
    }
    const unique = [...new Set(directions)];
    const only = unique[0];
    if (unique.length === 1 && only !== undefined) {
      conditions.push(eq(transactions.direction, only));
    }
  }
  if (input.amountMin !== undefined) {
    conditions.push(gte(transactions.amountMinor, checkAmount(input.amountMin, "amountMin")));
  }
  if (input.amountMax !== undefined) {
    conditions.push(lte(transactions.amountMinor, checkAmount(input.amountMax, "amountMax")));
  }
  if (
    input.amountMin !== undefined &&
    input.amountMax !== undefined &&
    checkAmount(input.amountMin, "amountMin") > checkAmount(input.amountMax, "amountMax")
  ) {
    fail(`Invalid range (amountMin above amountMax).`);
  }
  if (input.text !== undefined && input.text.trim() !== "") {
    if (input.text.length > 200) {
      fail("Invalid text (max 200 characters).");
    }
    conditions.push(ilike(transactions.description, `%${escapeLike(input.text.trim())}%`));
  }

  // Keyset position: rows strictly after the cursor in listing order.
  // (effective_date, id) tuple comparison keeps same-date pages exact.
  if (input.cursor !== undefined && input.cursor !== null) {
    const position = codec.decode(input.cursor, workspaceId);
    if (position.s !== sort) {
      fail("Invalid cursor (sort changed since the cursor was issued).");
    }
    const date = checkDate(position.d, "cursor.date");
    checkUuid(position.i, "cursor.id");
    // `or()` returns undefined only when called with zero conditions; both
    // branches below always pass two, and the guard keeps that explicit.
    const keyset =
      sort === "newest"
        ? or(
            lt(transactions.effectiveDate, date),
            and(eq(transactions.effectiveDate, date), lt(transactions.id, position.i)),
          )
        : or(
            gt(transactions.effectiveDate, date),
            and(eq(transactions.effectiveDate, date), gt(transactions.id, position.i)),
          );
    if (keyset === undefined) {
      fail("Invalid cursor (unpositionable).");
    }
    conditions.push(keyset);
  }

  const rows = await db
    .select()
    .from(transactions)
    .where(and(...conditions))
    .orderBy(
      ...(sort === "newest"
        ? [desc(transactions.effectiveDate), desc(transactions.id)]
        : [asc(transactions.effectiveDate), asc(transactions.id)]),
    )
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? codec.encode({ w: workspaceId, s: sort, d: last.effectiveDate, i: last.id })
      : null;
  return { items, nextCursor };
}
