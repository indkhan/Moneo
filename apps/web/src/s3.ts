// E02-S03 minimal S3-compatible object client on Node built-ins (no new
// dependencies): PUT/GET/HEAD/DELETE + bucket creation over SigV4. Used only
// for the private quarantine prefix under generated keys; database rows keep
// metadata/hashes, never bytes. Loopback test endpoint by default.

import { createHash, createHmac } from "node:crypto";

export type S3Config = {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
};

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Uint8Array {
  return createHmac("sha256", key).update(data).digest();
}

function signingKey(secret: string, date: string, region: string): Uint8Array {
  let key: Uint8Array = hmac(`AWS4${secret}`, date);
  key = hmac(key, region);
  key = hmac(key, "s3");
  key = hmac(key, "aws4_request");
  return key;
}

function amzDate(now = new Date()): { full: string; day: string } {
  const iso = now.toISOString();
  return { full: `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`, day: iso.slice(0, 10).replace(/-/g, "") };
}

/** Encode an object key for a path-style URL without allowing traversal. */
export function encodeObjectKey(key: string): string {
  if (key.includes("..") || key.startsWith("/") || key.includes("\\")) throw new Error("object key refused");
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
}

async function signedFetch(
  config: S3Config,
  method: string,
  key: string,
  body?: Uint8Array,
  contentType?: string,
): Promise<Response> {
  const encoded = encodeObjectKey(key);
  const url = `${config.endpoint.replace(/\/$/, "")}/${config.bucket}/${encoded}`;
  const { full, day } = amzDate();
  const payloadHash = sha256Hex(body ?? "");
  const headers: Record<string, string> = {
    host: new URL(url).host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": full,
  };
  if (contentType) headers["content-type"] = contentType;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonical = [
    method,
    `/${config.bucket}/${encoded}`,
    "",
    ...Object.keys(headers).sort().map((name) => `${name}:${headers[name]}`),
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", full, scope, sha256Hex(canonical)].join("\n");
  const signature = Buffer.from(hmac(signingKey(config.secretKey, day, config.region), toSign)).toString("hex");
  const auth = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const res = await fetch(url, {
    method,
    // Single content-type header (lowercase, as signed): adding a second
    // differently-cased copy breaks the SigV4 header match.
    headers: { ...headers, Authorization: auth },
    body: body ? Buffer.from(body) : undefined,
  });
  return res;
}

function check(res: Response, context: string): void {
  if (res.status >= 200 && res.status < 300) return;
  throw new Error(`s3 ${context} failed with status ${res.status}`);
}

/** PUT bytes under a generated quarantine key. Key must match the quarantine prefix. */
export async function s3Put(config: S3Config, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  assertQuarantineKey(key);
  const res = await signedFetch(config, "PUT", key, bytes, contentType);
  check(res, "put");
  await res.arrayBuffer().catch(() => undefined);
}

/** PUT bytes under a generated export key (E08-S01 private packages). */
export async function s3PutExport(config: S3Config, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  assertExportKey(key);
  const res = await signedFetch(config, "PUT", key, bytes, contentType);
  check(res, "put");
  await res.arrayBuffer().catch(() => undefined);
}

/** GET bytes for a quarantine key. Caps the download to maxBytes. */
export async function s3Get(config: S3Config, key: string, maxBytes: number): Promise<Uint8Array> {
  assertQuarantineKey(key);
  return s3GetAny(config, key, maxBytes);
}

/** GET bytes for a private export key. Caps the download to maxBytes. */
export async function s3GetExport(config: S3Config, key: string, maxBytes: number): Promise<Uint8Array> {
  assertExportKey(key);
  return s3GetAny(config, key, maxBytes);
}

async function s3GetAny(config: S3Config, key: string, maxBytes: number): Promise<Uint8Array> {
  const res = await signedFetch(config, "GET", key);
  check(res, "get");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error("s3 object exceeds admitted size");
  return buf;
}

export async function s3Head(config: S3Config, key: string): Promise<{ size: number } | null> {
  assertQuarantineKey(key);
  const res = await signedFetch(config, "HEAD", key);
  if (res.status === 404) return null;
  check(res, "head");
  const length = Number(res.headers.get("content-length") ?? "NaN");
  return { size: Number.isInteger(length) ? length : -1 };
}

export async function s3Delete(config: S3Config, key: string): Promise<void> {
  assertQuarantineKey(key);
  return s3DeleteAny(config, key);
}

/** DELETE a private export key (E08-S01 expiry path). */
export async function s3DeleteExport(config: S3Config, key: string): Promise<void> {
  assertExportKey(key);
  return s3DeleteAny(config, key);
}

async function s3DeleteAny(config: S3Config, key: string): Promise<void> {
  const res = await signedFetch(config, "DELETE", key);
  if (res.status === 404 || res.status === 204 || res.status === 200) return;
  check(res, "delete");
}

/** Create the bucket when absent (test bootstrap; deployment owns buckets). */
export async function s3EnsureBucket(config: S3Config): Promise<void> {
  const url = `${config.endpoint.replace(/\/$/, "")}/${config.bucket}/`;
  const { full, day } = amzDate();
  const headers: Record<string, string> = { host: new URL(url).host, "x-amz-content-sha256": sha256Hex(""), "x-amz-date": full };
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["PUT", `/${config.bucket}/`, "", `host:${headers["host"]}`, `x-amz-content-sha256:${headers["x-amz-content-sha256"]}`, `x-amz-date:${headers["x-amz-date"]}`, "", signedHeaders, sha256Hex("")].join("\n");
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const signature = Buffer.from(hmac(signingKey(config.secretKey, day, config.region), ["AWS4-HMAC-SHA256", full, scope, sha256Hex(canonical)].join("\n"))).toString("hex");
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
  });
  if (res.status === 200 || res.status === 409 || res.status === 403) {
    // 409 BucketAlreadyOwnedByYou, 403 on MinIO when the key lacks
    // s3:CreateBucket but the bucket exists and is usable — the suite then
    // proves usability with put/get; deployment owns real buckets.
    await res.arrayBuffer().catch(() => undefined);
    return;
  }
  check(res, "ensure-bucket");
}

/** List keys under a prefix (test isolation + future retention purge; XML parsed minimally). */
export async function s3ListKeys(config: S3Config, prefix: string, maxKeys = 1000): Promise<string[]> {
  if (prefix.includes("..") || prefix.includes("\\")) throw new Error("object key refused");
  // Encode every byte of the value, including '/' as %2F: SigV4 signs the
  // encoded canonical query string, and a raw slash mismatches the server.
  const encodedPrefix = prefix.split("/").map((part) => encodeURIComponent(part)).join("%2F");
  const url = `${config.endpoint.replace(/\/$/, "")}/${config.bucket}/?list-type=2&prefix=${encodedPrefix}&max-keys=${maxKeys}`;
  const { full, day } = amzDate();
  const headers: Record<string, string> = { host: new URL(url).host, "x-amz-content-sha256": sha256Hex(""), "x-amz-date": full };
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["GET", `/${config.bucket}/`, `list-type=2&max-keys=${maxKeys}&prefix=${encodedPrefix}`, `host:${headers["host"]}`, `x-amz-content-sha256:${headers["x-amz-content-sha256"]}`, `x-amz-date:${headers["x-amz-date"]}`, "", signedHeaders, sha256Hex("")].join("\n");
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const signature = Buffer.from(hmac(signingKey(config.secretKey, day, config.region), ["AWS4-HMAC-SHA256", full, scope, sha256Hex(canonical)].join("\n"))).toString("hex");
  const res = await fetch(url, {
    method: "GET",
    headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
  });
  check(res, "list");
  const xml = await res.text();
  const keys: string[] = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) keys.push(decodeURIComponent(match[1].replaceAll("+", " ")));
  return keys.filter((k) => k.startsWith("quarantine/") || k.startsWith("exports/"));
}

/** Quarantine keys are generated server-side and never contain traversal. */
export function assertQuarantineKey(key: string): void {
  if (!/^quarantine\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)) throw new Error("object key refused");
}

/** Server-generated quarantine key: no filename bytes, no traversal. */
export function quarantineKey(workspaceId: string, objectId: string): string {
  return `quarantine/${workspaceId}/${objectId}`;
}

/** Export package keys are generated server-side and never contain traversal. */
export function assertExportKey(key: string): void {
  if (!/^exports\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.enc$/.test(key)) throw new Error("object key refused");
}

/** Server-generated export key: unpredictable ids only, no filename bytes. */
export function exportKey(workspaceId: string, packageId: string): string {
  return `exports/${workspaceId}/${packageId}.enc`;
}
