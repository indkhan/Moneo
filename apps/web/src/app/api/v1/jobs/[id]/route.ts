import { getSession } from "@/lib/auth-session";
import { createDrizzleJobSubmissionStore, handleGetJob } from "@/lib/jobs-submit";

/**
 * GET /api/v1/jobs/{id} — one job's status. The wizard's processing step
 * polls this; rows are tenant-scoped, so foreign ids answer 404.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const { id } = await context.params;
  return handleGetJob(id, {
    workspaceId: session?.wid,
    jobs: createDrizzleJobSubmissionStore(),
  });
}
