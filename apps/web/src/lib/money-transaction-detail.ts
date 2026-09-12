import {
  getTransactionDetail,
  type TransactionDetail as DbTransactionDetail,
} from "@moneo/db/transaction-detail";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { DomainError, problemResponse } from "@moneo/shared/problem";
import { NextResponse } from "next/server";
import type { TransactionDetail as TransactionDetailDto } from "../generated/client";
import { parseOrProblem, transactionIdSchema } from "./contract";
import { toTransactionDto } from "./money-transactions";

/**
 * Issue 4.8 — transaction detail HTTP surface.
 *
 * One tenant-scoped read: canonical fields plus source/import provenance
 * with verbatim raw payloads ("View original"). Unknown and foreign ids
 * answer 404. Storage is injected so the handler unit-tests without
 * Postgres.
 */

export interface TransactionDetailStore {
  find(workspaceId: string, transactionId: string): Promise<DbTransactionDetail | null>;
}

export function createDrizzleTransactionDetailStore(): TransactionDetailStore {
  return {
    find: (workspaceId, transactionId) =>
      withWorkspaceTransaction(workspaceId, (tx) =>
        getTransactionDetail(tx, workspaceId, transactionId),
      ),
  };
}

export function toTransactionDetailDto(detail: DbTransactionDetail): TransactionDetailDto {
  return {
    ...toTransactionDto(detail.transaction),
    accountName: detail.accountName,
    sources: detail.sources.map((source) => ({
      sourceTransactionId: source.sourceTransactionId,
      relationship: source.relationship as TransactionDetailDto["sources"][number]["relationship"],
      dataSourceId: source.dataSourceId,
      dataSourceName: source.dataSourceName,
      importId: source.importId,
      fileName: source.fileName,
      observedAt: source.observedAt.toISOString(),
      rawPayload: source.rawPayload,
    })),
  };
}

function unauthorized(): Response {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** GET /api/v1/transactions/{id} — canonical fields plus provenance. */
export async function handleGetTransaction(
  id: unknown,
  ctx: { workspaceId: string | undefined; detail: TransactionDetailStore },
): Promise<Response> {
  if (!ctx.workspaceId) {
    return unauthorized();
  }
  const parsed = parseOrProblem(transactionIdSchema, id, "/transactions/{id}");
  if (!parsed.ok) {
    return problemResponse(parsed.error);
  }
  const detail = await ctx.detail.find(ctx.workspaceId, parsed.data);
  if (!detail) {
    return problemResponse(new DomainError("NOT_FOUND", { detail: "Transaction not found." }));
  }
  return NextResponse.json(toTransactionDetailDto(detail));
}
