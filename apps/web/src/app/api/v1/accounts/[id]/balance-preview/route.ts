import { loadEnv } from "@moneo/shared/env";
import { financeRoute } from "@/lib/finance-api";
import { createDrizzleBalancePreviewStore, handlePreviewBalance } from "@/lib/balance-preview";
import { searchCursorSecret } from "@/lib/money-transactions";

/**
 * GET /api/v1/accounts/{id}/balance-preview — project a proposed snapshot
 * over later transactions. Read-only; answers what recording WOULD do.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return financeRoute(async (session) => {
    const { id } = await context.params;
    return handlePreviewBalance(id, new URL(request.url).search, {
      workspaceId: session.wid,
      preview: createDrizzleBalancePreviewStore(searchCursorSecret(loadEnv())),
    });
  });
}
