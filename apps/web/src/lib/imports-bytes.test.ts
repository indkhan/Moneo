import { createMemoryObjectStore, sha256Hex } from "@moneo/shared/uploads";
import { describe, expect, it } from "vitest";
import { handlePutBytes } from "./imports-bytes";

/**
 * Issue 3.7 — statement byte upload.
 *
 * Proves: 401 without a workspace; malformed query (bad UUID, empty name)
 * rejected as problem+json before storage is touched; empty and oversize
 * bodies rejected; happy path stores under the session-bound quarantine key
 * and returns size + digest; a forged cross-workspace key can never be
 * addressed (the key is rebuilt server-side, never trusted from input).
 */

const WS_A = "11111111-1111-4111-8111-111111111111";
const IMPORT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

async function readProblem(response: Response): Promise<{ status: number; code: string }> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  const body = (await response.json()) as { code: string };
  return { status: response.status, code: body.code };
}

describe("handlePutBytes", () => {
  it("returns 401 without a workspace", async () => {
    const response = await handlePutBytes(
      { importId: IMPORT_A, fileName: "a.csv" },
      bytesOf("a,b\n1,2\n"),
      { workspaceId: undefined, store: createMemoryObjectStore() },
    );
    expect(response.status).toBe(401);
  });

  it("rejects malformed query without touching storage", async () => {
    const store = createMemoryObjectStore();
    const badId = await handlePutBytes({ importId: "nope", fileName: "a.csv" }, bytesOf("x"), {
      workspaceId: WS_A,
      store,
    });
    expect(await readProblem(badId)).toEqual({ status: 400, code: "VALIDATION_FAILED" });
    const badName = await handlePutBytes({ importId: IMPORT_A, fileName: "" }, bytesOf("x"), {
      workspaceId: WS_A,
      store,
    });
    expect(await readProblem(badName)).toEqual({ status: 400, code: "VALIDATION_FAILED" });
    expect(store.keys()).toEqual([]);
  });

  it("rejects empty and oversize bodies", async () => {
    const store = createMemoryObjectStore();
    const empty = await handlePutBytes(
      { importId: IMPORT_A, fileName: "a.csv" },
      new Uint8Array(),
      { workspaceId: WS_A, store },
    );
    expect(await readProblem(empty)).toEqual({ status: 400, code: "VALIDATION_FAILED" });
    const huge = await handlePutBytes(
      { importId: IMPORT_A, fileName: "a.csv" },
      new Uint8Array(10 * 1024 * 1024 + 1),
      { workspaceId: WS_A, store },
    );
    expect(await readProblem(huge)).toEqual({ status: 400, code: "VALIDATION_FAILED" });
    expect(store.keys()).toEqual([]);
  });

  it("stores bytes under the session-bound key and returns size + digest", async () => {
    const store = createMemoryObjectStore();
    const body = bytesOf("date,amount\n2026-01-01,12.50\n");
    const response = await handlePutBytes({ importId: IMPORT_A, fileName: "statement.csv" }, body, {
      workspaceId: WS_A,
      store,
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      importId: string;
      objectKey: string;
      bytes: number;
      sha256: string;
    };
    expect(result.importId).toBe(IMPORT_A);
    expect(result.objectKey).toBe(`quarantine/${WS_A}/${IMPORT_A}/statement.csv`);
    expect(result.bytes).toBe(body.length);
    expect(result.sha256).toBe(sha256Hex(body));
    expect(await store.get(result.objectKey)).not.toBeNull();
  });

  it("neutralizes traversal in the file name the same way completion does", async () => {
    const store = createMemoryObjectStore();
    const response = await handlePutBytes(
      { importId: IMPORT_A, fileName: "../../evil.csv" },
      bytesOf("a"),
      { workspaceId: WS_A, store },
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { objectKey: string };
    expect(result.objectKey).toBe(`quarantine/${WS_A}/${IMPORT_A}/evil.csv`);
  });
});
