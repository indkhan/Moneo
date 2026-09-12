import { getSession } from "@/lib/auth-session";
import { getUploadStore, handleInitiateUpload } from "@/lib/imports-upload";

/**
 * POST /api/v1/imports/initiate — validate a statement declaration and
 * reserve a private quarantine key. The session's workspace (`wid`) scopes
 * the tenant; the response carries an internal key, never a public URL.
 */
export async function POST(request: Request) {
  const session = await getSession();
  const body: unknown = await request.json().catch(() => null);
  return handleInitiateUpload(body, {
    workspaceId: session?.wid,
    store: getUploadStore(),
  });
}
