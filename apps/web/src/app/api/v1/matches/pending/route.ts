import { getSession } from "@/lib/auth-session";
import { createDrizzleMatchReviewStore, handleListPendingMatches } from "@/lib/match-review";

/**
 * GET /api/v1/matches/pending?importId= — staged review rows for one
 * import. Read-only; decisions go through `matches.resolve`.
 */
export async function GET(request: Request) {
  const session = await getSession();
  return handleListPendingMatches(new URL(request.url).search, {
    workspaceId: session?.wid,
    review: createDrizzleMatchReviewStore(),
  });
}
