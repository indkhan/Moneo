import type { AppEnv } from "@moneo/shared/env";
import { DomainError, problemResponse } from "@moneo/shared/problem";
import {
  createSearchCursorCodec,
  searchTransactions,
  type TransactionSearchPage,
} from "@moneo/db/transaction-queries";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { NextResponse } from "next/server";
import type { Transaction as TransactionDto } from "../generated/client";
import { parseOrProblem, transactionSearchQuerySchema } from "./contract";

/**
 * Issue 4.7 — canonical transaction search HTTP surface.
 *
 * Parses the query string through the contract schema FIRST (malformed
 * requests become VALIDATION_FAILED, never a partial query), then runs the
 * shared domain search (Issue 4.6) inside `withWorkspaceTransaction`.
 * Amounts serialize as decimal strings; the cursor passes through opaque.
 * Storage is injected so handlers unit-test without Postgres.
 */

export interface MoneyTransactionStore {
  search(
    workspaceId: string,
    input: {
      /** Raw comma-separated account UUIDs (split + validated downstream). */
      accountIds?: string;
      dateFrom?: string;
      dateTo?: string;
      /** Raw comma-separated credit/debit list. */
      directions?: string;
      amountMin?: string;
      amountMax?: string;
      text?: string;
      sort?: "newest" | "oldest";
      limit?: number;
      cursor?: string | null;
    },
  ): Promise<TransactionSearchPage>;
}

/** Server-side secret for the HMAC-bound search cursor. Never leaves the server. */
export function searchCursorSecret(env: AppEnv): string {
  const secret = env.SEARCH_CURSOR_SECRET ?? env.SESSION_SECRET;
  if (!secret) {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", {
      detail: "Transaction search is not configured (SEARCH_CURSOR_SECRET or SESSION_SECRET).",
    });
  }
  return secret;
}

export function createDrizzleMoneyTransactionStore(secret: string): MoneyTransactionStore {
  const codec = createSearchCursorCodec(secret);
  const split = (list: string | undefined): string[] | undefined =>
    list === undefined
      ? undefined
      : list
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
  return {
    search: (workspaceId, input) =>
      withWorkspaceTransaction(workspaceId, (tx) =>
        searchTransactions(
          tx,
          workspaceId,
          {
            ...(split(input.accountIds) !== undefined
              ? { accountIds: split(input.accountIds) }
              : {}),
            ...(input.dateFrom !== undefined ? { dateFrom: input.dateFrom } : {}),
            ...(input.dateTo !== undefined ? { dateTo: input.dateTo } : {}),
            ...(split(input.directions) !== undefined
              ? {
                  directions: split(input.directions) as ("credit" | "debit")[],
                }
              : {}),
            ...(input.amountMin !== undefined ? { amountMin: input.amountMin } : {}),
            ...(input.amountMax !== undefined ? { amountMax: input.amountMax } : {}),
            ...(input.text !== undefined ? { text: input.text } : {}),
            ...(input.sort !== undefined ? { sort: input.sort } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
          },
          codec,
        ),
      ),
  };
}

export function toTransactionDto(row: TransactionSearchPage["items"][number]): TransactionDto {
  return {
    id: row.id,
    accountId: row.accountId,
    status: row.status as TransactionDto["status"],
    direction: row.direction as TransactionDto["direction"],
    amountMinor: String(row.amountMinor),
    currencyCode: row.currencyCode,
    effectiveDate: row.effectiveDate,
    description: row.description,
    note: row.note,
    excludedFromAnalytics: row.excludedFromAnalytics,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function unauthorized(): Response {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** GET /api/v1/transactions/search — keyset cursor page over canonical transactions. */
export async function handleSearchTransactions(
  query: string | null,
  ctx: { workspaceId: string | undefined; transactions: MoneyTransactionStore },
): Promise<Response> {
  if (!ctx.workspaceId) {
    return unauthorized();
  }
  const params = new URLSearchParams(query ?? "");
  const parsed = parseOrProblem(
    transactionSearchQuerySchema,
    Object.fromEntries(params.entries()),
    "/transactions/search",
  );
  if (!parsed.ok) {
    return problemResponse(parsed.error);
  }
  try {
    const page = await ctx.transactions.search(ctx.workspaceId, {
      ...(parsed.data.accountIds !== undefined ? { accountIds: parsed.data.accountIds } : {}),
      ...(parsed.data.dateFrom !== undefined ? { dateFrom: parsed.data.dateFrom } : {}),
      ...(parsed.data.dateTo !== undefined ? { dateTo: parsed.data.dateTo } : {}),
      ...(parsed.data.directions !== undefined ? { directions: parsed.data.directions } : {}),
      ...(parsed.data.amountMin !== undefined ? { amountMin: parsed.data.amountMin } : {}),
      ...(parsed.data.amountMax !== undefined ? { amountMax: parsed.data.amountMax } : {}),
      ...(parsed.data.q !== undefined ? { text: parsed.data.q } : {}),
      sort: parsed.data.sort,
      limit: parsed.data.limit,
      ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
    });
    return NextResponse.json({
      items: page.items.map(toTransactionDto),
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    if (error instanceof DomainError) {
      return problemResponse(error);
    }
    throw error;
  }
}
