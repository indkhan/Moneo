import { describe, expect, it } from "vitest";
import { DomainError } from "./problem.js";
import {
  assertPrivateKey,
  buildQuarantineKey,
  completeUpload,
  createMemoryObjectStore,
  extensionOf,
  initiateUpload,
  mimeForExtension,
  sanitizeFileName,
  sha256Hex,
  STATEMENT_EXTENSIONS,
  UPLOAD_MAX_BYTES,
  type ObjectStore,
} from "./uploads.js";

/**
 * Issue 3.2 — private statement upload flow.
 *
 * Proves, in order: extension handling (case, paths, edge names); file-name
 * sanitization (traversal stripped, garbage rejected, length capped);
 * quarantine key shape (private prefix, tenant binding, no URL forms);
 * initiation validation (type/size/workspace matrix with exact problem
 * codes); completion verification (happy-path metadata, missing object,
 * oversize bytes, digest mismatch, cross-tenant and forged keys all fail
 * closed); the memory store's isolation (copies, not aliases); the SHA-256
 * helper against published vectors; and that no public-URL surface exists.
 */

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const IMPORT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

async function expectDomain(
  promise: Promise<unknown>,
  code: DomainError["code"],
): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return error as DomainError;
  }
  throw new Error(`Expected DomainError(${code}), but the call succeeded`);
}

describe("statement file extensions", () => {
  it("accepts exactly .csv and .xlsx", () => {
    expect([...STATEMENT_EXTENSIONS]).toEqual(["csv", "xlsx"]);
    expect(mimeForExtension("csv")).toBe("text/csv");
    expect(mimeForExtension("xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("detects extensions case-insensitively through paths", () => {
    expect(extensionOf("statement.csv")).toBe("csv");
    expect(extensionOf("Statement.CSV")).toBe("csv");
    expect(extensionOf("export.XLSX")).toBe("xlsx");
    expect(extensionOf("C:\\Users\\me\\bank.export.csv")).toBe("csv");
    expect(extensionOf("/tmp/a.b.c.xlsx")).toBe("xlsx");
  });

  it("returns null for names without a usable extension", () => {
    expect(extensionOf("statement")).toBeNull();
    expect(extensionOf(".csv")).toBeNull();
    expect(extensionOf("statement.")).toBeNull();
    expect(extensionOf("")).toBeNull();
  });
});

describe("file-name sanitization", () => {
  it("strips directories and traversal, keeping the base name", () => {
    expect(sanitizeFileName("../../etc/passwd.csv")).toBe("passwd.csv");
    expect(sanitizeFileName("C:\\Windows\\statement.csv")).toBe("statement.csv");
    expect(sanitizeFileName("my bank export (1).CSV")).toBe("my_bank_export_1_.CSV");
  });

  it("rejects names with nothing safe left", () => {
    expect(() => sanitizeFileName("../../")).toThrow(DomainError);
    expect(() => sanitizeFileName("")).toThrow(DomainError);
    try {
      sanitizeFileName("...");
    } catch (error) {
      expect((error as DomainError).code).toBe("VALIDATION_FAILED");
    }
  });

  it("caps runaway names at 128 chars", () => {
    expect(sanitizeFileName(`${"a".repeat(500)}.csv`).length).toBeLessThanOrEqual(128);
  });
});

describe("quarantine keys", () => {
  it("builds private tenant-bound keys with no public URL form", () => {
    const key = buildQuarantineKey(WS_A, IMPORT_A, "statement.csv");
    expect(key).toBe(`quarantine/${WS_A}/${IMPORT_A}/statement.csv`);
    expect(key).not.toMatch(/^https?:\/\//);
    expect(() => new URL(key)).toThrow();
  });

  it("neutralizes traversal in the file-name segment", () => {
    const key = buildQuarantineKey(WS_A, IMPORT_A, "../../evil.csv");
    expect(key).toBe(`quarantine/${WS_A}/${IMPORT_A}/evil.csv`);
    expect(key).not.toContain("..");
  });

  it("rejects non-UUID tenant bindings", () => {
    expect(() => buildQuarantineKey("not-a-uuid", IMPORT_A, "a.csv")).toThrow();
    expect(() => buildQuarantineKey(WS_A, "not-a-uuid", "a.csv")).toThrow();
  });

  it("assertPrivateKey accepts quarantine keys and rejects everything else", () => {
    expect(() => {
      assertPrivateKey(`quarantine/${WS_A}/${IMPORT_A}/a.csv`);
    }).not.toThrow();
    for (const bad of [
      "https://cdn.example.com/quarantine/a.csv",
      "http://localhost:9000/moneo-quarantine/a.csv",
      "s3://moneo-quarantine/a.csv",
      "quarantine/../other/a.csv",
      "quarantine\\windows\\a.csv",
      "/quarantine/a.csv",
      "uploads/a.csv",
      "",
    ]) {
      expect(() => {
        assertPrivateKey(bad);
      }, bad).toThrow(DomainError);
    }
  });
});

describe("initiateUpload", () => {
  it("reserves a key per declaration with the right mime and bound", () => {
    const csv = initiateUpload({ workspaceId: WS_A, fileName: "bank.csv", contentLength: 1024 });
    expect(csv.mime).toBe("text/csv");
    expect(csv.maxBytes).toBe(UPLOAD_MAX_BYTES);
    expect(csv.objectKey).toBe(`quarantine/${WS_A}/${csv.importId}/bank.csv`);

    const xlsx = initiateUpload({
      workspaceId: WS_A,
      fileName: "BANK.XLSX",
      contentLength: 2048,
    });
    expect(xlsx.mime).toContain("spreadsheetml");
    expect(xlsx.importId).not.toBe(csv.importId);
  });

  it("rejects forbidden types with VALIDATION_FAILED", () => {
    // Matching is strict on purpose: a trailing space is not a .csv file,
    // and the uploader should rename rather than have us guess.
    for (const fileName of [
      "notes.pdf",
      "macro.xlsm",
      "run.exe",
      "noextension",
      ".csv",
      "a.csv ",
      "statement.csv.exe",
    ]) {
      let error: DomainError | null = null;
      try {
        initiateUpload({ workspaceId: WS_A, fileName, contentLength: 10 });
      } catch (e) {
        error = e as DomainError;
      }
      expect(error, fileName).toBeInstanceOf(DomainError);
      expect(error?.code).toBe("VALIDATION_FAILED");
    }
  });

  it("rejects bad sizes with VALIDATION_FAILED", () => {
    for (const contentLength of [0, -1, 1.5, Number.NaN, UPLOAD_MAX_BYTES + 1]) {
      try {
        initiateUpload({ workspaceId: WS_A, fileName: "a.csv", contentLength });
      } catch (error) {
        expect((error as DomainError).code).toBe("VALIDATION_FAILED");
        continue;
      }
      throw new Error(`contentLength ${contentLength} should have been rejected`);
    }
    // Exactly at the bound is allowed.
    expect(
      initiateUpload({ workspaceId: WS_A, fileName: "a.csv", contentLength: UPLOAD_MAX_BYTES })
        .maxBytes,
    ).toBe(UPLOAD_MAX_BYTES);
  });

  it("rejects a non-UUID workspace with VALIDATION_FAILED", () => {
    let error: DomainError | null = null;
    try {
      initiateUpload({ workspaceId: "workspace-a", fileName: "a.csv", contentLength: 10 });
    } catch (e) {
      error = e as DomainError;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect(error?.code).toBe("VALIDATION_FAILED");
  });
});

describe("memory object store", () => {
  it("round-trips bytes as copies, tracks existence and size", async () => {
    const store = createMemoryObjectStore();
    const key = buildQuarantineKey(WS_A, IMPORT_A, "a.csv");
    expect(await store.exists(key)).toBe(false);
    expect(await store.sizeOf(key)).toBeNull();
    expect(await store.get(key)).toBeNull();

    const original = bytesOf("date,amount\n2026-01-01,12.50\n");
    await store.put(key, original);
    expect(await store.exists(key)).toBe(true);
    expect(await store.sizeOf(key)).toBe(original.length);

    const first = (await store.get(key)) as Uint8Array;
    expect(Buffer.from(first).toString("utf8")).toContain("2026-01-01");
    first[0] = 0xff; // mutating the copy must not corrupt the stored bytes
    expect((await store.get(key))?.[0]).toBe(original[0]);
    expect(store.keys()).toEqual([key]);
    store.clear();
    expect(await store.exists(key)).toBe(false);
  });

  it("refuses to store under a public-looking key", () => {
    const store = createMemoryObjectStore();
    // `put` throws synchronously before any promise exists: nothing is stored.
    expect(() => store.put("https://cdn.example.com/a.csv", bytesOf("x"))).toThrow(DomainError);
    expect(store.keys()).toEqual([]);
  });
});

describe("completeUpload", () => {
  async function setup(
    store: ObjectStore,
    fileName = "statement.csv",
    body = "date,amount\n2026-01-01,12.50\n",
  ) {
    const initiated = initiateUpload({ workspaceId: WS_A, fileName, contentLength: body.length });
    await store.put(initiated.objectKey, bytesOf(body));
    return initiated;
  }

  it("verifies bytes and returns stored metadata", async () => {
    const store = createMemoryObjectStore();
    const initiated = await setup(store);
    const done = await completeUpload(
      {
        workspaceId: WS_A,
        importId: initiated.importId,
        objectKey: initiated.objectKey,
        fileName: "statement.csv",
      },
      store,
    );
    expect(done.workspaceId).toBe(WS_A);
    expect(done.importId).toBe(initiated.importId);
    expect(done.objectKey).toBe(initiated.objectKey);
    expect(done.mime).toBe("text/csv");
    expect(done.bytes).toBe(bytesOf("date,amount\n2026-01-01,12.50\n").length);
    expect(done.sha256).toBe(sha256Hex(bytesOf("date,amount\n2026-01-01,12.50\n")));
    expect(done.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a matching client-declared digest", async () => {
    const store = createMemoryObjectStore();
    const body = "a,b\n1,2\n";
    const initiated = await setup(store, "a.csv", body);
    const done = await completeUpload(
      {
        workspaceId: WS_A,
        importId: initiated.importId,
        objectKey: initiated.objectKey,
        fileName: "a.csv",
        expectedSha256: sha256Hex(bytesOf(body)),
      },
      store,
    );
    expect(done.bytes).toBe(bytesOf(body).length);
  });

  it("fails closed on a missing object with NOT_FOUND", async () => {
    const store = createMemoryObjectStore();
    const initiated = initiateUpload({ workspaceId: WS_A, fileName: "a.csv", contentLength: 5 });
    await expectDomain(
      completeUpload(
        {
          workspaceId: WS_A,
          importId: initiated.importId,
          objectKey: initiated.objectKey,
          fileName: "a.csv",
        },
        store,
      ),
      "NOT_FOUND",
    );
  });

  it("rejects oversize stored bytes even when declared small", async () => {
    const store = createMemoryObjectStore();
    const initiated = initiateUpload({ workspaceId: WS_A, fileName: "a.csv", contentLength: 3 });
    await store.put(initiated.objectKey, new Uint8Array(UPLOAD_MAX_BYTES + 1));
    await expectDomain(
      completeUpload(
        {
          workspaceId: WS_A,
          importId: initiated.importId,
          objectKey: initiated.objectKey,
          fileName: "a.csv",
        },
        store,
      ),
      "VALIDATION_FAILED",
    );
  });

  it("rejects a digest mismatch with VALIDATION_FAILED", async () => {
    const store = createMemoryObjectStore();
    const initiated = await setup(store);
    await expectDomain(
      completeUpload(
        {
          workspaceId: WS_A,
          importId: initiated.importId,
          objectKey: initiated.objectKey,
          fileName: "statement.csv",
          expectedSha256: "0".repeat(64),
        },
        store,
      ),
      "VALIDATION_FAILED",
    );
  });

  it("rejects cross-workspace completion with FORBIDDEN", async () => {
    const store = createMemoryObjectStore();
    const initiated = await setup(store);
    // Same bytes, but workspace B tries to claim workspace A's key.
    await expectDomain(
      completeUpload(
        {
          workspaceId: WS_B,
          importId: initiated.importId,
          objectKey: initiated.objectKey,
          fileName: "statement.csv",
        },
        store,
      ),
      "FORBIDDEN",
    );
  });

  it("rejects forged sibling keys with FORBIDDEN", async () => {
    const store = createMemoryObjectStore();
    const initiated = await setup(store);
    const sibling = buildQuarantineKey(WS_A, initiated.importId, "other.csv");
    await store.put(sibling, bytesOf("forged"));
    await expectDomain(
      completeUpload(
        {
          workspaceId: WS_A,
          importId: initiated.importId,
          objectKey: sibling,
          fileName: "statement.csv",
        },
        store,
      ),
      "FORBIDDEN",
    );
  });

  it("rejects non-quarantine keys and bad file types", async () => {
    const store = createMemoryObjectStore();
    await expectDomain(
      completeUpload(
        {
          workspaceId: WS_A,
          importId: IMPORT_A,
          objectKey: "https://cdn.example.com/a.csv",
          fileName: "a.csv",
        },
        store,
      ),
      "VALIDATION_FAILED",
    );
    // A smuggled executable under a well-formed quarantine key: the key
    // round-trips (buildQuarantineKey does not judge types) so completion
    // reaches the type check and rejects it there.
    const smuggledKey = buildQuarantineKey(WS_A, IMPORT_A, "payload.exe");
    await store.put(smuggledKey, bytesOf("evil"));
    await expectDomain(
      completeUpload(
        {
          workspaceId: WS_A,
          importId: IMPORT_A,
          objectKey: smuggledKey,
          fileName: "payload.exe",
        },
        store,
      ),
      "VALIDATION_FAILED",
    );
    // And a renamed completion (key no longer matches the initiated name)
    // fails on binding first, even when both names are legal statements.
    const initiated = initiateUpload({ workspaceId: WS_A, fileName: "a.csv", contentLength: 4 });
    await store.put(initiated.objectKey, bytesOf("evil"));
    await expectDomain(
      completeUpload(
        {
          workspaceId: WS_A,
          importId: initiated.importId,
          objectKey: initiated.objectKey,
          fileName: "renamed.csv",
        },
        store,
      ),
      "FORBIDDEN",
    );
  });
});

describe("sha256 helper", () => {
  it("matches published test vectors", () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(bytesOf("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("no public-URL surface", () => {
  it("exposes no signed/public URL helper", async () => {
    const module = await import("./uploads.js");
    for (const name of Object.keys(module)) {
      expect(name.toLowerCase()).not.toMatch(/publicurl|signedurl|presign|cfront/);
    }
  });
});
