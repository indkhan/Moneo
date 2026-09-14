import { financeRoute } from "@/lib/finance-api";
import { handlePutBytes } from "@/lib/imports-bytes";
import { getUploadStore } from "@/lib/imports-upload";

/**
 * POST /api/v1/imports/bytes?importId=…&fileName=… — raw octet-stream body.
 * Carries the statement bytes through the server into quarantine storage
 * (never a signed public URL). Bounded at the upload limit; follow with
 * `/imports/complete`.
 */
export async function POST(request: Request) {
  return financeRoute(async (session) => {
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    return handlePutBytes(
      { importId: url.searchParams.get("importId"), fileName: url.searchParams.get("fileName") },
      body,
      { workspaceId: session.wid, store: getUploadStore() },
    );
  });
}
