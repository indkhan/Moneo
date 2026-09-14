import { loadEnv } from "@moneo/shared/env";
import { financeRoute } from "@/lib/finance-api";
import {
  createDrizzleMoneyTransactionStore,
  handleSearchTransactions,
  searchCursorSecret,
} from "@/lib/money-transactions";

/**
 * GET /api/v1/transactions/search — keyset cursor page over canonical
 * transactions. Server-side filter/sort only; the browser never pages with
 * OFFSET and never re-sorts rows locally.
 */
export async function GET(request: Request) {
  return financeRoute((session) =>
    handleSearchTransactions(new URL(request.url).search, {
      workspaceId: session.wid,
      transactions: createDrizzleMoneyTransactionStore(searchCursorSecret(loadEnv())),
    }),
  );
}
