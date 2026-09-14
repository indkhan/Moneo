import { financeRoute } from "@/lib/finance-api";
import {
  createDrizzleTransactionDetailStore,
  handleGetTransaction,
} from "@/lib/money-transaction-detail";

/**
 * GET /api/v1/transactions/{id} — canonical fields plus source/import
 * provenance. Foreign ids answer 404, never a cross-workspace row.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return financeRoute(async (session) => {
    const { id } = await context.params;
    return handleGetTransaction(id, {
      workspaceId: session.wid,
      detail: createDrizzleTransactionDetailStore(),
    });
  });
}
