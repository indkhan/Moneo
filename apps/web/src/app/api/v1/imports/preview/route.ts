import { getSession } from "@/lib/auth-session";
import { getUploadStore } from "@/lib/imports-upload";
import { handlePreview } from "@/lib/imports-preview";

/**
 * POST /api/v1/imports/preview — parse quarantined bytes server-side and
 * auto-detect the column mapping for the wizard's preview/mapping steps.
 * Row-shape problems surface as data; structural breakage fails closed.
 */
export async function POST(request: Request) {
  const session = await getSession();
  const body: unknown = await request.json().catch(() => null);
  return handlePreview(body, { workspaceId: session?.wid, store: getUploadStore() });
}
