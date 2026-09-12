import { getAccount } from "@moneo/db/account-queries";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { previewReconciliation, type ReconciliationPreview } from "@moneo/finance";
import { DomainError, problemResponse } from "@moneo/shared/problem";
import { NextResponse } from "next/server";
import { z } from "zod";
import { accountIdSchema, parseOrProblem } from "./contract";
import { createDrizzleMoneyTransactionStore } from "./money-transactions";

/**
 * Issue 4.10 — balance preview HTTP surface.
 *
 * Answers "what would this snapshot do?" BEFORE anything is written: the
 * caller proposes `currentAmountMinor` + `cutoffDate`, the handler lists
 * transactions on/after the cutoff (capped), and the shared preview math
 * reports the projection or the honest unresolved reason. Read-only: no
 * command, no mutation, safe to call on every keystroke.
 */

const PREVIEW_TXN_CAP = 1000;

export const balancePreviewQuerySchema = z.object({
  currentAmountMinor: z
    .string()
    .regex(/^-?(0|[1-9][0-9]*)$/, "must be signed integer-string minor units"),
  currencyCode: z.string().regex(/^[A-Za-z]{3}$/, "must be an ISO 4217 code"),
  cutoffDate: z
    .string()
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "must be a YYYY-MM-DD date")
    .nullable()
    .optional(),
});

export interface BalancePreviewStore {
  findAccount(
    workspaceId: string,
    accountId: string,
  ): Promise<{ id: string; currencyCode: string } | null>;
  listTransactions(
    workspaceId: string,
    accountId: string,
    cutoffDate: string | null,
  ): Promise<{
    items: {
      id: string;
      effectiveDate: string;
      direction: "credit" | "debit";
      amountMinor: string;
      currencyCode: string;
    }[];
    truncated: boolean;
  }>;
}

export function createDrizzleBalancePreviewStore(secret: string): BalancePreviewStore {
  const transactions = createDrizzleMoneyTransactionStore(secret);
  return {
    findAccount: (workspaceId, accountId) =>
      withWorkspaceTransaction(workspaceId, (tx) =>
        getAccount(tx, workspaceId, accountId).then((account) =>
          account ? { id: account.id, currencyCode: account.currencyCode } : null,
        ),
      ),
    listTransactions: async (workspaceId, accountId, cutoffDate) => {
      if (cutoffDate === null) {
        return { items: [], truncated: false };
      }
      const page = await transactions.search(workspaceId, {
        accountIds: accountId,
        dateFrom: cutoffDate,
        sort: "oldest",
        limit: PREVIEW_TXN_CAP,
      });
      return {
        items: page.items.map((row) => ({
          id: row.id,
          effectiveDate: row.effectiveDate,
          direction: row.direction as "credit" | "debit",
          amountMinor: String(row.amountMinor),
          currencyCode: row.currencyCode,
        })),
        truncated: page.items.length === PREVIEW_TXN_CAP && page.nextCursor !== null,
      };
    },
  };
}

function unauthorized(): Response {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** GET /api/v1/accounts/{id}/balance-preview — project a proposed snapshot. */
export async function handlePreviewBalance(
  id: unknown,
  query: string | null,
  ctx: { workspaceId: string | undefined; preview: BalancePreviewStore },
): Promise<Response> {
  if (!ctx.workspaceId) {
    return unauthorized();
  }
  const idParsed = parseOrProblem(accountIdSchema, id, "/accounts/{id}/balance-preview");
  if (!idParsed.ok) {
    return problemResponse(idParsed.error);
  }
  const params = new URLSearchParams(query ?? "");
  const queryParsed = parseOrProblem(
    balancePreviewQuerySchema,
    Object.fromEntries(params.entries()),
    "/accounts/{id}/balance-preview",
  );
  if (!queryParsed.ok) {
    return problemResponse(queryParsed.error);
  }
  const account = await ctx.preview.findAccount(ctx.workspaceId, idParsed.data);
  if (!account) {
    return problemResponse(new DomainError("NOT_FOUND", { detail: "Account not found." }));
  }
  if (queryParsed.data.currencyCode.toUpperCase() !== account.currencyCode.toUpperCase()) {
    return problemResponse(
      new DomainError("VALIDATION_FAILED", {
        detail: `Preview currency ${queryParsed.data.currencyCode} must match account currency ${account.currencyCode}.`,
        errors: [{ field: "currencyCode", message: "must match the account currency" }],
      }),
    );
  }
  const cutoffDate = queryParsed.data.cutoffDate ?? null;
  const { items, truncated } = await ctx.preview.listTransactions(
    ctx.workspaceId,
    account.id,
    cutoffDate,
  );
  try {
    const preview: ReconciliationPreview = previewReconciliation(
      {
        observedAt: new Date().toISOString(),
        currentAmountMinor: queryParsed.data.currentAmountMinor,
        availableAmountMinor: null,
        currencyCode: account.currencyCode,
        source: "manual",
        cutoffDate,
      },
      items,
      { truncated },
    );
    return NextResponse.json(preview);
  } catch (error) {
    if (error instanceof DomainError) {
      return problemResponse(error);
    }
    throw error;
  }
}
