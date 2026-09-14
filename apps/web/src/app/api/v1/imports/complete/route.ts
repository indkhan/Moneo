import { financeRoute } from "@/lib/finance-api";
import { getUploadStore, handleCompleteUpload } from "@/lib/imports-upload";

/**
 * POST /api/v1/imports/complete — verify quarantined bytes and store their
 * metadata. Fails closed (404/403/400 problems); the worker (Issue 3.6)
 * picks the completed import up from here.
 */
export async function POST(request: Request) {
  return financeRoute(async (session) => {
    const body: unknown = await request.json().catch(() => null);
    return handleCompleteUpload(body, {
      workspaceId: session.wid,
      store: getUploadStore(),
    });
  });
}
