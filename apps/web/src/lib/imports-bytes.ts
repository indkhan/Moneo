import { UPLOAD_MAX_BYTES } from "@moneo/shared/uploads";
import type { ObjectStore } from "@moneo/shared/uploads";
import { buildQuarantineKey, sha256Hex } from "@moneo/shared/uploads";
import { DomainError, problemResponse } from "@moneo/shared/problem";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseOrProblem } from "./contract";
import { getUploadStore } from "./imports-upload";

/**
 * Issue 3.7 — statement byte upload.
 *
 * The 3.2 flow reserved a quarantine key and verified bytes, but the browser
 * had no way to SEND bytes through the server (never a signed public URL).
 * `POST /api/v1/imports/bytes?importId=…&fileName=…` closes that gap with a
 * raw octet-stream body: the server rebuilds the expected quarantine key
 * from the session workspace (the same binding `complete` enforces), caps
 * the body at the upload bound, stores the bytes, and returns their size
 * and digest. The wizard calls initiate → bytes → complete in order.
 */

export const putBytesQuerySchema = z.object({
  importId: z.uuid("importId must be a UUID"),
  fileName: z.string().min(1, "fileName is required").max(256),
});

export interface PutBytesResult {
  importId: string;
  objectKey: string;
  bytes: number;
  sha256: string;
}

/** Store a raw upload body under the session-bound quarantine key. */
export async function handlePutBytes(
  query: unknown,
  body: Uint8Array,
  ctx: { workspaceId: string | undefined; store?: ObjectStore },
): Promise<Response> {
  if (!ctx.workspaceId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = parseOrProblem(putBytesQuerySchema, query, "/imports/bytes");
  if (!parsed.ok) {
    return problemResponse(parsed.error);
  }
  let objectKey: string;
  try {
    objectKey = buildQuarantineKey(ctx.workspaceId, parsed.data.importId, parsed.data.fileName);
  } catch (error) {
    return error instanceof DomainError
      ? problemResponse(error)
      : NextResponse.json({ error: "internal" }, { status: 500 });
  }
  if (body.length === 0) {
    return problemResponse(
      new DomainError("VALIDATION_FAILED", {
        detail: "Upload body is empty.",
        errors: [{ field: "body", message: "must not be empty" }],
      }),
    );
  }
  if (body.length > UPLOAD_MAX_BYTES) {
    return problemResponse(
      new DomainError("VALIDATION_FAILED", {
        detail: `File too large: ${body.length} bytes exceeds the ${UPLOAD_MAX_BYTES} byte limit.`,
        errors: [{ field: "file", message: `must be at most ${UPLOAD_MAX_BYTES} bytes` }],
      }),
    );
  }
  const store = ctx.store ?? getUploadStore();
  await store.put(objectKey, body);
  return NextResponse.json({
    importId: parsed.data.importId,
    objectKey,
    bytes: body.length,
    sha256: sha256Hex(body),
  } satisfies PutBytesResult);
}
