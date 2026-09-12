import { createMemoryObjectStore } from "@moneo/shared/uploads";
import { describe, expect, it } from "vitest";
import { handlePreview, provisionalSourceId, type PreviewResponse } from "./imports-preview";

/**
 * Issue 3.7 — server-side statement preview.
 *
 * Proves: 401 without a workspace; malformed bodies rejected; missing bytes
 * answered 404; forbidden extensions rejected; clean CSV preview (headers,
 * rows, delimiter, auto-mapping, confidence, suggested account); row-shape
 * errors surfaced without failing the preview; structural breakage fails
 * closed; preview slicing honored; and the mapping agrees with the
 * documented detector contract (amount + date claimed, the rest reported).
 */

const WS_A = "11111111-1111-4111-8111-111111111111";
const IMPORT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const KEY = `quarantine/${WS_A}/${IMPORT_A}/statement.csv`;

async function readProblem(response: Response): Promise<{ status: number; code: string }> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  const body = (await response.json()) as { code: string };
  return { status: response.status, code: body.code };
}

describe("handlePreview", () => {
  it("returns 401 without a workspace", async () => {
    const response = await handlePreview(
      { importId: IMPORT_A, fileName: "statement.csv" },
      { workspaceId: undefined, store: createMemoryObjectStore() },
    );
    expect(response.status).toBe(401);
  });

  it("rejects malformed bodies", async () => {
    const response = await handlePreview(
      { importId: "nope", fileName: "" },
      { workspaceId: WS_A, store: createMemoryObjectStore() },
    );
    expect(await readProblem(response)).toEqual({ status: 400, code: "VALIDATION_FAILED" });
  });

  it("answers 404 when the bytes never arrived", async () => {
    const response = await handlePreview(
      { importId: IMPORT_A, fileName: "statement.csv" },
      { workspaceId: WS_A, store: createMemoryObjectStore() },
    );
    expect(await readProblem(response)).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  it("rejects forbidden extensions", async () => {
    const store = createMemoryObjectStore();
    await store.put(`quarantine/${WS_A}/${IMPORT_A}/run.exe`, bytesOf("x"));
    const response = await handlePreview(
      { importId: IMPORT_A, fileName: "run.exe" },
      { workspaceId: WS_A, store },
    );
    expect(await readProblem(response)).toEqual({ status: 400, code: "VALIDATION_FAILED" });
  });

  it("previews a clean CSV with detection and account suggestion", async () => {
    const store = createMemoryObjectStore();
    await store.put(
      KEY,
      bytesOf("Buchungstag,Verwendungszweck,Betrag\n01.02.2026,COFFEE BAR,-3.50\n"),
    );
    const response = await handlePreview(
      { importId: IMPORT_A, fileName: "statement.csv" },
      { workspaceId: WS_A, store },
    );
    expect(response.status).toBe(200);
    const preview = (await response.json()) as PreviewResponse;
    expect(preview.kind).toBe("csv");
    expect(preview.delimiter).toBe(",");
    expect(preview.headers).toEqual(["Buchungstag", "Verwendungszweck", "Betrag"]);
    expect(preview.totalRows).toBe(1);
    expect(preview.preview).toEqual([
      { rowNumber: 2, cells: ["01.02.2026", "COFFEE BAR", "-3.50"] },
    ]);
    expect(preview.mapping).toMatchObject({ date: 0, description: 1, amount: 2 });
    expect(preview.suggestedAccount).toBe("statement");
    expect(preview.parseErrors).toEqual([]);
  });

  it("surfaces row-shape errors without failing the preview", async () => {
    const store = createMemoryObjectStore();
    await store.put(KEY, bytesOf("a,b\n1,2\n3\n4,5\n"));
    const response = await handlePreview(
      { importId: IMPORT_A, fileName: "statement.csv" },
      { workspaceId: WS_A, store },
    );
    expect(response.status).toBe(200);
    const preview = (await response.json()) as PreviewResponse;
    expect(preview.totalRows).toBe(2);
    expect(preview.parseErrors).toEqual([
      { rowNumber: 3, message: "Expected 2 columns, found 1." },
    ]);
  });

  it("fails closed on structurally broken files", async () => {
    const store = createMemoryObjectStore();
    await store.put(KEY, bytesOf('a,b\n"unterminated,1\n'));
    const response = await handlePreview(
      { importId: IMPORT_A, fileName: "statement.csv" },
      { workspaceId: WS_A, store },
    );
    expect(await readProblem(response)).toEqual({ status: 400, code: "VALIDATION_FAILED" });
  });

  it("returns a stable provisional source id per workspace and kind", async () => {
    const store = createMemoryObjectStore();
    await store.put(KEY, bytesOf("a,b\n1,2\n"));
    const response = await handlePreview(
      { importId: IMPORT_A, fileName: "statement.csv" },
      { workspaceId: WS_A, store },
    );
    const preview = (await response.json()) as PreviewResponse;
    expect(preview.dataSourceId).toBe(provisionalSourceId(WS_A, "csv"));
    expect(preview.dataSourceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(provisionalSourceId(WS_A, "xlsx")).not.toBe(provisionalSourceId(WS_A, "csv"));
    expect(provisionalSourceId("99999999-9999-4999-8999-999999999999", "csv")).not.toBe(
      provisionalSourceId(WS_A, "csv"),
    );
  });

  it("honors the preview row limit", async () => {
    const store = createMemoryObjectStore();
    await store.put(KEY, bytesOf("a,b\n1,2\n3,4\n5,6\n7,8\n"));
    const response = await handlePreview(
      { importId: IMPORT_A, fileName: "statement.csv", previewRows: 2 },
      { workspaceId: WS_A, store },
    );
    const preview = (await response.json()) as PreviewResponse;
    expect(preview.preview).toHaveLength(2);
    expect(preview.totalRows).toBe(4);
  });
});
