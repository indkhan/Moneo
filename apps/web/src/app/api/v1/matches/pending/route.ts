import { financeRoute } from "@/lib/finance-api";
import { createDrizzleMatchReviewStore, handleListPendingMatches } from "@/lib/match-review";

/**
 * GET /api/v1/matches/pending?importId= — staged review rows for one
 * import. Read-only; decisions go through `matches.resolve`.
 */
export async function GET(request: Request) {
  return financeRoute((session) =>
    handleListPendingMatches(new URL(request.url).search, {
      workspaceId: session.wid,
      review: createDrizzleMatchReviewStore(),
    }),
  );
}
