import { createMemoryObjectStore, sha256Hex } from "@moneo/shared/uploads";
import { describe, expect, it } from "vitest";
import {
  completeUploadRequestSchema,
  getUploadStore,
  handleCompleteUpload,
  handleInitiateUpload,
  initiateUploadRequestSchema,
  resetUploadStoreForTests,
} from "./imports-upload";

/**
 * Issue 3.2 — HTTP adapter for the private upload flow.
 *
 * Proves, in order: request schemas accept the documented shapes and reject
 * everything else (oversize declarations, bad UUIDs/digests, empty names);
 * both handlers require a workspace (401 without one, never a 500 or a
 * cross-tenant success); initiation returns a tenant-bound quarantine key
 * and rejects forbidden types/sizes as problem+json; completion verifies
 * stored bytes end-to-end (200 metadata), answers 404 for missing objects,
 * 403 for cross-workspace claims, and 400 for digest mismatches; every
 * failure is `application/problem+json` with the documented code.
 */

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

async function readProblem(response: Response): Promise<{ status: number; code: string }> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  const body = (await response.json()) as { code: string };
  return { status: response.status, code: body.code };
}

describe("upload request schemas", () => {
  it("accepts minimal valid bodies", () => {
    expect(
      initiateUploadRequestSchema.safeParse({ fileName: "a.csv", contentLength: 12 }).success,
    ).toBe(true);
    expect(
      completeUploadRequestSchema.safeParse({
        importId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        objectKey: "quarantine/w/i/a.csv",
        fileName: "a.csv",
      }).success,
    ).toBe(true);
  });

  it("rejects malformed declarations", () => {
    expect(initiateUploadRequestSchema.safeParse({ fileName: "", contentLength: 12 }).success).toBe(
      false,
    );
    expect(
      initiateUploadRequestSchema.safeParse({ fileName: "a.csv", contentLength: 0 }).success,
    ).toBe(false);
    expect(
      initiateUploadRequestSchema.safeParse({ fileName: "a.pdf", contentLength: 12 }).success,
    ).toBe(true); // shape-valid here; the type rule lives in the domain layer
    expect(
      completeUploadRequestSchema.safeParse({
        importId: "not-a-uuid",
        objectKey: "k",
        fileName: "a.csv",
      }).success,
    ).toBe(false);
    expect(
      completeUploadRequestSchema.safeParse({
        importId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        objectKey: "k",
        fileName: "a.csv",
        expectedSha256: "ZZZ",
      }).success,
    ).toBe(false);
  });
});

describe("handleInitiateUpload", () => {
  it("returns 401 without a workspace", () => {
    const response = handleInitiateUpload(
      { fileName: "a.csv", contentLength: 10 },
      { workspaceId: undefined, store: createMemoryObjectStore() },
    );
    expect(response.status).toBe(401);
  });

  it("reserves a tenant-bound quarantine key", async () => {
    const response = handleInitiateUpload(
      { fileName: "bank.csv", contentLength: 100 },
      { workspaceId: WS_A, store: createMemoryObjectStore() },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      importId: string;
      objectKey: string;
      mime: string;
    };
    expect(body.mime).toBe("text/csv");
    expect(body.objectKey.startsWith(`quarantine/${WS_A}/${body.importId}/`)).toBe(true);
    expect(body.objectKey).not.toMatch(/^https?:\/\//);
  });

  it("maps forbidden types to a 400 problem", async () => {
    const response = handleInitiateUpload(
      { fileName: "run.exe", contentLength: 100 },
      { workspaceId: WS_A, store: createMemoryObjectStore() },
    );
    expect(await readProblem(response)).toEqual({ status: 400, code: "VALIDATION_FAILED" });
  });

  it("maps malformed bodies to a 400 problem with field errors", async () => {
    const response = handleInitiateUpload(
      { fileName: "", contentLength: -3 },
      { workspaceId: WS_A, store: createMemoryObjectStore() },
    );
    const problem = await readProblem(response);
    expect(problem).toEqual({ status: 400, code: "VALIDATION_FAILED" });
    const body = (await handleInitiateUpload(
      { fileName: "", contentLength: -3 },
      { workspaceId: WS_A, store: createMemoryObjectStore() },
    ).json()) as { errors: { field: string }[] };
    expect(body.errors.length).toBeGreaterThan(0);
  });
});

describe("handleCompleteUpload", () => {
  it("returns 401 without a workspace", async () => {
    const response = await handleCompleteUpload(
      { importId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", objectKey: "k", fileName: "a.csv" },
      { workspaceId: undefined, store: createMemoryObjectStore() },
    );
    expect(response.status).toBe(401);
  });

  it("completes a real initiated upload end to end", async () => {
    resetUploadStoreForTests();
    const store = getUploadStore();
    const initiated = (await handleInitiateUpload(
      { fileName: "statement.csv", contentLength: 8 },
      { workspaceId: WS_A, store },
    ).json()) as { importId: string; objectKey: string };
    const body = bytesOf("a,b\n1,2\n");
    await store.put(initiated.objectKey, body);

    const response = await handleCompleteUpload(
      {
        importId: initiated.importId,
        objectKey: initiated.objectKey,
        fileName: "statement.csv",
        expectedSha256: sha256Hex(body),
      },
      { workspaceId: WS_A, store },
    );
    expect(response.status).toBe(200);
    const done = (await response.json()) as { bytes: number; sha256: string; mime: string };
    expect(done).toMatchObject({ bytes: 8, sha256: sha256Hex(body), mime: "text/csv" });
  });

  it("answers 404 when the bytes never arrived", async () => {
    const initiated = (await handleInitiateUpload(
      { fileName: "a.csv", contentLength: 8 },
      { workspaceId: WS_A, store: createMemoryObjectStore() },
    ).json()) as { importId: string; objectKey: string };
    const response = await handleCompleteUpload(
      { importId: initiated.importId, objectKey: initiated.objectKey, fileName: "a.csv" },
      { workspaceId: WS_A, store: createMemoryObjectStore() },
    );
    expect(await readProblem(response)).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  it("answers 403 when another workspace claims the key", async () => {
    const store = createMemoryObjectStore();
    const initiated = (await handleInitiateUpload(
      { fileName: "a.csv", contentLength: 8 },
      { workspaceId: WS_A, store },
    ).json()) as { importId: string; objectKey: string };
    await store.put(initiated.objectKey, bytesOf("a,b\n1,2\n"));
    const response = await handleCompleteUpload(
      { importId: initiated.importId, objectKey: initiated.objectKey, fileName: "a.csv" },
      { workspaceId: WS_B, store },
    );
    expect(await readProblem(response)).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  it("answers 400 on a digest mismatch", async () => {
    const store = createMemoryObjectStore();
    const initiated = (await handleInitiateUpload(
      { fileName: "a.csv", contentLength: 8 },
      { workspaceId: WS_A, store },
    ).json()) as { importId: string; objectKey: string };
    await store.put(initiated.objectKey, bytesOf("a,b\n1,2\n"));
    const response = await handleCompleteUpload(
      {
        importId: initiated.importId,
        objectKey: initiated.objectKey,
        fileName: "a.csv",
        expectedSha256: "0".repeat(64),
      },
      { workspaceId: WS_A, store },
    );
    expect(await readProblem(response)).toEqual({ status: 400, code: "VALIDATION_FAILED" });
  });

  it("rejects malformed completion bodies before touching storage", async () => {
    const store = createMemoryObjectStore();
    const response = await handleCompleteUpload(
      { importId: "nope", objectKey: "", fileName: "" },
      { workspaceId: WS_A, store },
    );
    expect(await readProblem(response)).toEqual({ status: 400, code: "VALIDATION_FAILED" });
    expect(store.keys()).toEqual([]);
  });
});
