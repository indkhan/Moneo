import { getSession } from "@/lib/auth-session";
import { createDrizzleJobSubmissionStore, handleSubmitJob } from "@/lib/jobs-submit";

/**
 * POST /api/v1/jobs — submit a durable job (today: wizard import jobs).
 * Idempotent per dedupe key: retried submits return the original row.
 */
export async function POST(request: Request) {
  const session = await getSession();
  const body: unknown = await request.json().catch(() => null);
  return handleSubmitJob(body, {
    workspaceId: session?.wid,
    jobs: createDrizzleJobSubmissionStore(),
  });
}
