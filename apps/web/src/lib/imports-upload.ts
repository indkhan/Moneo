import { UPLOAD_MAX_BYTES } from "@moneo/shared/uploads";
import type { ObjectStore } from "@moneo/shared/uploads";
import {
  completeUpload,
  createConfiguredS3ObjectStore,
  createMemoryObjectStore,
  initiateUpload,
} from "@moneo/shared/uploads";
import { loadEnv } from "@moneo/shared/env";
import { DomainError, problemResponse } from "@moneo/shared/problem";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseOrProblem } from "./contract";

/**
 * Route handlers answer with plain `Response` (problem+json on failure):
 * `problemResponse` already builds the exact contract body, so the adapter
 * returns it untouched instead of re-wrapping it as a NextResponse.
 */

/**
 * Issue 3.2 — HTTP adapter for the private upload flow.
 *
 * All request validation and response mapping lives here as pure,
 * unit-testable functions. The two route files only resolve the session
 * (`wid` scopes the tenant) and hand the body to these handlers, so the
 * security behavior below is covered without booting Next.
 *
 * The store is process-local memory for now (local dev + tests). Swapping in
 * MinIO/S3 changes `getUploadStore` only — handlers keep the same contract.
 */

export const initiateUploadRequestSchema = z.object({
  fileName: z.string().min(1, "fileName is required").max(256),
  contentLength: z.number().int().positive().max(UPLOAD_MAX_BYTES),
});

export const completeUploadRequestSchema = z.object({
  importId: z.uuid("importId must be a UUID"),
  objectKey: z.string().min(1, "objectKey is required").max(512),
  fileName: z.string().min(1, "fileName is required").max(256),
  expectedSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "expectedSha256 must be a lowercase SHA-256 hex digest")
    .optional(),
});

let store: ObjectStore | undefined;

/** Process-local quarantine store (see module doc for the S3 swap plan). */
export function getUploadStore(): ObjectStore {
  if (!store) {
    const env = loadEnv();
    store =
      env.APP_ENV === "test" || process.env.VITEST
        ? createMemoryObjectStore()
        : createConfiguredS3ObjectStore({
            endpoint: env.S3_ENDPOINT,
            region: env.S3_REGION,
            bucket: env.S3_BUCKET,
            accessKeyId: env.S3_ACCESS_KEY,
            secretAccessKey: env.S3_SECRET_KEY,
          });
  }
  return store;
}

/** Test-only reset so uploads never leak between cases. */
export function resetUploadStoreForTests(): void {
  store = undefined;
}

function unauthorized(): Response {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

function failure(error: unknown): Response {
  if (error instanceof DomainError) {
    return problemResponse(error);
  }
  return NextResponse.json({ error: "internal" }, { status: 500 });
}

/** POST /api/v1/imports/initiate — validate the declaration, reserve a key. */
export function handleInitiateUpload(
  body: unknown,
  ctx: { workspaceId: string | undefined; store?: ObjectStore },
): Response {
  if (!ctx.workspaceId) {
    return unauthorized();
  }
  const parsed = parseOrProblem(initiateUploadRequestSchema, body, "/imports/initiate");
  if (!parsed.ok) {
    return problemResponse(parsed.error);
  }
  try {
    const initiated = initiateUpload({
      workspaceId: ctx.workspaceId,
      fileName: parsed.data.fileName,
      contentLength: parsed.data.contentLength,
    });
    return NextResponse.json(initiated);
  } catch (error) {
    return failure(error);
  }
}

/** POST /api/v1/imports/complete — verify quarantined bytes, store metadata. */
export async function handleCompleteUpload(
  body: unknown,
  ctx: { workspaceId: string | undefined; store?: ObjectStore },
): Promise<Response> {
  if (!ctx.workspaceId) {
    return unauthorized();
  }
  const parsed = parseOrProblem(completeUploadRequestSchema, body, "/imports/complete");
  if (!parsed.ok) {
    return problemResponse(parsed.error);
  }
  try {
    const completed = await completeUpload(
      {
        workspaceId: ctx.workspaceId,
        importId: parsed.data.importId,
        objectKey: parsed.data.objectKey,
        fileName: parsed.data.fileName,
        expectedSha256: parsed.data.expectedSha256,
      },
      ctx.store ?? getUploadStore(),
    );
    return NextResponse.json(completed);
  } catch (error) {
    return failure(error);
  }
}
