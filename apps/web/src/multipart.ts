// E02-S03 bounded multipart/form-data parser on Node built-ins (no new
// dependencies): exactly one file part plus small text fields. Byte-counted
// from the first chunk so oversized uploads fail before materialising.
// Filenames arrive as metadata only and are sanitized by the caller.

import type { IncomingMessage } from "node:http";

export type MultipartFile = {
  fieldName: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
};

export type MultipartForm = { fields: Record<string, string>; file: MultipartFile | null };

function boundaryOf(contentType: string | undefined): Uint8Array | null {
  const match = (contentType ?? "").match(/boundary=([^;]+)/);
  if (!match) return null;
  const boundary = match[1].trim().replace(/^"|"$/g, "");
  if (boundary.length < 1 || boundary.length > 128 || /[\r\n]/.test(boundary)) return null;
  return Buffer.from(`--${boundary}`, "utf8");
}

function splitBuffer(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const hay = Buffer.from(haystack);
  return hay.indexOf(Buffer.from(needle), from);
}

/** Read a multipart body with hard byte + field caps. Throws body_too_large / body_invalid. */
export async function readMultipart(req: IncomingMessage, opts: { maxBytes: number; maxFields?: number }): Promise<MultipartForm> {
  const boundary = boundaryOf(req.headers["content-type"]);
  if (!boundary) throw new Error("body_invalid");
  const maxFields = opts.maxFields ?? 10;
  const chunks: Uint8Array[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Uint8Array) => {
      total += chunk.byteLength;
      if (total > opts.maxBytes) {
        req.destroy();
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve());
    req.on("error", reject);
  });
  const body = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const fields: Record<string, string> = {};
  let file: MultipartFile | null = null;
  let fieldCount = 0;
  let cursor = 0;
  for (;;) {
    const start = splitBuffer(body, boundary, cursor);
    if (start < 0) break;
    let at = start + boundary.byteLength;
    // Final `--boundary--` terminator ends the form.
    if (body.subarray(at, at + 2).toString() === "--") break;
    if (body.subarray(at, at + 2).toString() !== "\r\n") throw new Error("body_invalid");
    at += 2;
    const headerEnd = splitBuffer(body, Buffer.from("\r\n\r\n"), at);
    if (headerEnd < 0) throw new Error("body_invalid");
    const headers = body.subarray(at, headerEnd).toString("latin1");
    const disposition = headers.match(/Content-Disposition:\s*form-data;\s*name="([^"]{1,128})"(?:;\s*filename="([^"]{0,256})")?/i);
    if (!disposition) throw new Error("body_invalid");
    const fieldName = disposition[1];
    const filename = disposition[2];
    const typeMatch = headers.match(/Content-Type:\s*([^\r\n;]{1,128})/i);
    const contentStart = headerEnd + 4;
    const next = splitBuffer(body, boundary, contentStart);
    if (next < 0) throw new Error("body_invalid");
    // Part bodies end with CRLF before the boundary; strip it.
    let contentEnd = next;
    if (contentEnd >= 2 && body.subarray(contentEnd - 2, contentEnd).toString() === "\r\n") contentEnd -= 2;
    const content = body.subarray(contentStart, contentEnd);
    fieldCount += 1;
    if (fieldCount > maxFields + 1) throw new Error("body_too_large");
    if (filename !== undefined) {
      if (file) throw new Error("body_invalid");
      file = {
        fieldName,
        filename,
        contentType: (typeMatch?.[1] ?? "application/octet-stream").trim().slice(0, 128),
        bytes: new Uint8Array(content),
      };
    } else {
      if (Object.keys(fields).length >= maxFields) throw new Error("body_too_large");
      const value = Buffer.from(content).toString("utf8");
      if (value.length > 8192) throw new Error("body_too_large");
      fields[fieldName] = value;
    }
    cursor = next;
  }
  return { fields, file };
}

/** Keep the original filename as display metadata only: basename, no
 * controls, capped length. Storage keys are always generated. */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200);
  if (!clean) return "upload";
  return clean;
}
