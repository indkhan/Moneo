import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { LIMITS, loadLimits, type LimitsConfig } from "./limits.js";
import { DomainError } from "./problem.js";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Issue 3.2 — private statement upload flow.
 *
 * A statement file travels: `initiate upload -> quarantine object ->
 * complete upload -> stored metadata`. The browser NEVER receives a public
 * URL: `buildQuarantineKey` returns an internal `quarantine/…` object key
 * that only server-side code resolves through an `ObjectStore`. There is
 * deliberately no `getPublicUrl` helper — adding one later must be a
 * reviewed, explicit decision, not an accident.
 *
 * This module is pure and dependency-free (node:crypto + zod only) so the
 * rules are unit-testable without S3. Production wires the same `ObjectStore`
 * interface to MinIO/S3; the key layout and validation do not change.
 */

const uuidSchema = z.uuid("must be a UUID");

/** Statement kinds this epoch ingests. Anything else is rejected at initiation. */
export const STATEMENT_EXTENSIONS = ["csv", "xlsx"] as const;
export type StatementExtension = (typeof STATEMENT_EXTENSIONS)[number];

const MIME_OF: Record<StatementExtension, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Lower-cased extension without the dot, or null when there is none. */
export function extensionOf(fileName: string): string | null {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return null;
  }
  return base.slice(dot + 1).toLowerCase();
}

export function mimeForExtension(extension: StatementExtension): string {
  return MIME_OF[extension];
}

/**
 * Strip directories, traversal, and unsafe characters. Caps at 128 chars so
 * the object key stays bounded. Throws VALIDATION_FAILED when nothing safe
 * remains (e.g. `"../../"`).
 */
export function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 128);
  const stripped = cleaned.replace(/^[._]+/, "");
  if (stripped.length === 0) {
    throw new DomainError("VALIDATION_FAILED", {
      detail: `File name "${fileName}" has no usable base name.`,
      errors: [{ field: "fileName", message: "must include a safe base name" }],
    });
  }
  return stripped;
}

/**
 * Internal quarantine key. The `quarantine/` prefix marks bytes that have
 * NOT passed validation yet; the worker (Issue 3.6) is the only reader.
 * Workspace + import ids in the path keep one tenant's bytes addressable
 * only alongside its own ids (checked again at completion).
 */
export function buildQuarantineKey(
  workspaceId: string,
  importId: string,
  fileName: string,
): string {
  uuidSchema.parse(workspaceId);
  uuidSchema.parse(importId);
  return `quarantine/${workspaceId}/${importId}/${sanitizeFileName(fileName)}`;
}

/** Reject anything that is not an internal quarantine key (URLs, escapes, siblings). */
export function assertPrivateKey(objectKey: string): void {
  if (
    !objectKey.startsWith("quarantine/") ||
    objectKey.includes("..") ||
    objectKey.includes("\\") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(objectKey)
  ) {
    throw new DomainError("VALIDATION_FAILED", {
      detail: `Object key "${objectKey}" is not a private quarantine key.`,
      errors: [{ field: "objectKey", message: "must be a quarantine/ key" }],
    });
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface InitiateUploadInput {
  workspaceId: string;
  fileName: string;
  /** Declared byte size. The stored object is re-checked at completion. */
  contentLength: number;
}

export interface InitiatedUpload {
  importId: string;
  objectKey: string;
  mime: string;
  maxBytes: number;
}

/**
 * Step 1 — validate the declaration and reserve a quarantine key.
 * Writes nothing; the browser PUTs bytes to the returned key through the
 * server (never a signed public URL), then calls `completeUpload`.
 */
export function initiateUpload(
  input: InitiateUploadInput,
  limits: LimitsConfig = loadLimits(),
): InitiatedUpload {
  const parsedWorkspace = uuidSchema.safeParse(input.workspaceId);
  if (!parsedWorkspace.success) {
    throw new DomainError("VALIDATION_FAILED", {
      detail: "workspaceId must be a UUID.",
      errors: [{ field: "workspaceId", message: "must be a UUID" }],
    });
  }
  const extension = extensionOf(input.fileName);
  if (extension === null || !(STATEMENT_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new DomainError("VALIDATION_FAILED", {
      detail: `File "${input.fileName}" must end in ${STATEMENT_EXTENSIONS.map((e) => `.${e}`).join(" or ")}.`,
      errors: [{ field: "fileName", message: "must be a .csv or .xlsx statement file" }],
    });
  }
  if (!Number.isInteger(input.contentLength) || input.contentLength <= 0) {
    throw new DomainError("VALIDATION_FAILED", {
      detail: "contentLength must be a positive integer.",
      errors: [{ field: "contentLength", message: "must be a positive integer" }],
    });
  }
  if (input.contentLength > limits.uploadMaxBytes) {
    throw new DomainError("VALIDATION_FAILED", {
      detail: `File too large: ${input.contentLength} bytes exceeds the ${limits.uploadMaxBytes} byte limit.`,
      errors: [{ field: "file", message: `must be at most ${limits.uploadMaxBytes} bytes` }],
    });
  }
  const importId = randomUUID();
  return {
    importId,
    objectKey: buildQuarantineKey(input.workspaceId, importId, input.fileName),
    mime: MIME_OF[extension as StatementExtension],
    maxBytes: limits.uploadMaxBytes,
  };
}

/** Minimal object-store surface. Memory now, MinIO/S3 later — same interface. */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  sizeOf(key: string): Promise<number | null>;
}

export function createMemoryObjectStore(): ObjectStore & { keys(): string[]; clear(): void } {
  const objects = new Map<string, Uint8Array>();
  return {
    keys: () => [...objects.keys()],
    clear: () => {
      objects.clear();
    },
    put: (key, bytes) => {
      assertPrivateKey(key);
      objects.set(key, bytes.slice());
      return Promise.resolve();
    },
    get: (key) => {
      const found = objects.get(key);
      return Promise.resolve(found ? found.slice() : null);
    },
    exists: (key) => Promise.resolve(objects.has(key)),
    sizeOf: (key) => {
      const found = objects.get(key);
      return Promise.resolve(found ? found.length : null);
    },
  };
}

type S3Sender = { send(command: object): Promise<unknown> };

/** Private MinIO/S3 adapter shared by web and worker processes. */
export function createS3ObjectStore(options: { bucket: string; client: S3Sender }): ObjectStore {
  const head = async (key: string): Promise<{ ContentLength?: number } | null> => {
    assertPrivateKey(key);
    try {
      return (await options.client.send(
        new HeadObjectCommand({ Bucket: options.bucket, Key: key }),
      )) as { ContentLength?: number };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === "NotFound") return null;
      throw error;
    }
  };
  return {
    async put(key, bytes) {
      assertPrivateKey(key);
      await options.client.send(
        new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: bytes }),
      );
    },
    async get(key) {
      assertPrivateKey(key);
      try {
        const result = (await options.client.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: key }),
        )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
        return result.Body ? new Uint8Array(await result.Body.transformToByteArray()) : null;
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (status === 404 || (error as { name?: string }).name === "NoSuchKey") return null;
        throw error;
      }
    },
    exists: (key) => head(key).then(Boolean),
    sizeOf: (key) => head(key).then((result) => result?.ContentLength ?? null),
  };
}

export function createConfiguredS3ObjectStore(config: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): ObjectStore {
  return createS3ObjectStore({
    bucket: config.bucket,
    client: new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    }),
  });
}

export interface CompleteUploadInput {
  workspaceId: string;
  importId: string;
  objectKey: string;
  fileName: string;
  /** When the uploader hashed the bytes client-side, the server re-checks it. */
  expectedSha256?: string;
}

export interface CompletedUpload {
  workspaceId: string;
  importId: string;
  objectKey: string;
  fileName: string;
  mime: string;
  bytes: number;
  sha256: string;
}

/**
 * Step 3 — verify the quarantined bytes and store their metadata.
 * Fails CLOSED: unknown keys, cross-tenant keys, oversize objects, and hash
 * mismatches all throw before any metadata is returned.
 */
export async function completeUpload(
  input: CompleteUploadInput,
  store: ObjectStore,
  limits: LimitsConfig = loadLimits(),
): Promise<CompletedUpload> {
  const parsedWorkspace = uuidSchema.safeParse(input.workspaceId);
  const parsedImport = uuidSchema.safeParse(input.importId);
  if (!parsedWorkspace.success || !parsedImport.success) {
    throw new DomainError("VALIDATION_FAILED", {
      detail: "workspaceId and importId must be UUIDs.",
      errors: [{ field: "workspaceId", message: "must be a UUID" }],
    });
  }
  assertPrivateKey(input.objectKey);
  const expectedKey = buildQuarantineKey(input.workspaceId, input.importId, input.fileName);
  if (input.objectKey !== expectedKey) {
    // The key must round-trip initiation exactly: a key minted for another
    // workspace/import (or a hand-forged sibling) can never complete here.
    throw new DomainError("FORBIDDEN", {
      detail: "Object key does not belong to this workspace upload.",
    });
  }
  const bytes = await store.get(input.objectKey);
  if (!bytes) {
    throw new DomainError("NOT_FOUND", {
      detail: "Quarantined upload not found. Initiate the upload again.",
    });
  }
  if (bytes.length > limits.uploadMaxBytes) {
    throw new DomainError("VALIDATION_FAILED", {
      detail: `File too large: ${bytes.length} bytes exceeds the ${limits.uploadMaxBytes} byte limit.`,
      errors: [{ field: "file", message: `must be at most ${limits.uploadMaxBytes} bytes` }],
    });
  }
  const extension = extensionOf(input.fileName);
  if (extension === null || !(STATEMENT_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new DomainError("VALIDATION_FAILED", {
      detail: `File "${input.fileName}" must end in .csv or .xlsx.`,
      errors: [{ field: "fileName", message: "must be a .csv or .xlsx statement file" }],
    });
  }
  const sha256 = sha256Hex(bytes);
  if (input.expectedSha256 !== undefined && input.expectedSha256 !== sha256) {
    throw new DomainError("VALIDATION_FAILED", {
      detail: "Uploaded bytes do not match the declared SHA-256 digest.",
      errors: [{ field: "sha256", message: "bytes do not match the declared digest" }],
    });
  }
  return {
    workspaceId: input.workspaceId,
    importId: input.importId,
    objectKey: input.objectKey,
    fileName: sanitizeFileName(input.fileName),
    mime: MIME_OF[extension as StatementExtension],
    bytes: bytes.length,
    sha256,
  };
}

/** Re-exported for route layers that quote the bound without importing limits. */
export const UPLOAD_MAX_BYTES = LIMITS.uploadMaxBytes;
