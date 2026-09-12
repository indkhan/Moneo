import { getSession } from "@/lib/auth-session";
import { createDrizzleMoneyAccountStore, handleListAccounts } from "@/lib/money-accounts";

/**
 * GET /api/v1/accounts — workspace accounts with latest known balances.
 * Unknown balances serialize as null, never zero.
 */
export async function GET(request: Request) {
  const session = await getSession();
  return handleListAccounts(new URL(request.url).search, {
    workspaceId: session?.wid,
    accounts: createDrizzleMoneyAccountStore(),
  });
}
