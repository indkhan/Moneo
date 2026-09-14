import { financeRoute } from "@/lib/finance-api";
import { createDrizzleMoneyAccountStore, handleGetAccount } from "@/lib/money-accounts";

/**
 * GET /api/v1/accounts/{id} — one account. Foreign ids answer 404, never
 * a cross-workspace row.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return financeRoute(async (session) => {
    const { id } = await context.params;
    return handleGetAccount(id, {
      workspaceId: session.wid,
      accounts: createDrizzleMoneyAccountStore(),
    });
  });
}
