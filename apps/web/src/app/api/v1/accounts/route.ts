import { financeRoute } from "@/lib/finance-api";
import { createDrizzleMoneyAccountStore, handleListAccounts } from "@/lib/money-accounts";

/**
 * GET /api/v1/accounts — workspace accounts with latest known balances.
 * Unknown balances serialize as null, never zero.
 */
export async function GET(request: Request) {
  return financeRoute((session) =>
    handleListAccounts(new URL(request.url).search, {
      workspaceId: session.wid,
      accounts: createDrizzleMoneyAccountStore(),
    }),
  );
}
