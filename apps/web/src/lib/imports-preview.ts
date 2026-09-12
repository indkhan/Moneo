import type { ColumnMapping, DetectedMapping, MappingConfidence } from "@moneo/finance";
import { detectColumnMapping, parseCsvBytes, parseXlsxBytes } from "@moneo/finance";
import type { ObjectStore } from "@moneo/shared/uploads";
import { buildQuarantineKey, extensionOf, sha256Hex } from "@moneo/shared/uploads";
import { DomainError, problemResponse } from "@moneo/shared/problem";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseOrProblem } from "./contract";
import { getUploadStore } from "./imports-upload";

/**
 * Issue 3.7 — server-side statement preview.
 *
 * The wizard's preview/mapping steps need headers, sample rows, and an
 * auto-detected mapping — for CSV and XLSX alike. Parsing runs HERE (the
 * domain parsers need Node, and the browser must never sniff uploads
 * itself): `POST /api/v1/imports/preview` rebuilds the session-bound
 * quarantine key, parses the quarantined bytes with the bounded parsers,
 * and returns the first rows plus detection. Mapping data errors never
 * fail the preview; structural file failures do (same fail-closed rule as
 * the worker).
 */

export const previewRequestSchema = z.object({
  importId: z.uuid("importId must be a UUID"),
  fileName: z.string().min(1, "fileName is required").max(256),
  previewRows: z.number().int().min(1).max(20).optional(),
});

export interface PreviewRow {
  rowNumber: number;
  cells: string[];
}

export interface PreviewResponse {
  importId: string;
  /** Provisional statement source id (see `provisionalSourceId`). */
  dataSourceId: string;
  fileName: string;
  kind: "csv" | "xlsx";
  delimiter: string | null;
  headers: string[];
  preview: PreviewRow[];
  totalRows: number;
  parseErrors: { rowNumber: number; message: string }[];
  mapping: ColumnMapping;
  confidence: Record<string, MappingConfidence>;
  unmapped: number[];
  suggestedAccount: string;
}

function suggestedAccountFor(fileName: string): string {
  const stem =
    fileName
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]*$/, "")
      .trim() ?? "";
  return stem === "" ? "Imported account" : stem;
}

/**
 * Stable per-workspace source id WITHOUT a database round-trip: the
 * SHA-256 of the tenant + kind, formatted as a UUID. Provisional on
 * purpose — the day preview provisions a real `data_sources` row (Epoch 4
 * canonicalization), this returns that row's id and no caller changes:
 * same field, same stability, same tenant binding.
 */
export function provisionalSourceId(workspaceId: string, kind: "csv" | "xlsx"): string {
  const digest = sha256Hex(new TextEncoder().encode(`moneo:source:${kind}:${workspaceId}`));
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Parse quarantined bytes and detect the column mapping. */
export async function handlePreview(
  body: unknown,
  ctx: { workspaceId: string | undefined; store?: ObjectStore },
): Promise<Response> {
  if (!ctx.workspaceId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = parseOrProblem(previewRequestSchema, body, "/imports/preview");
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
  const store = ctx.store ?? getUploadStore();
  const workspaceId = ctx.workspaceId;
  const bytes = await store.get(objectKey);
  if (!bytes) {
    return problemResponse(
      new DomainError("NOT_FOUND", {
        detail: "Quarantined upload not found. Upload the file again.",
      }),
    );
  }
  const extension = extensionOf(parsed.data.fileName);
  if (extension !== "csv" && extension !== "xlsx") {
    return problemResponse(
      new DomainError("VALIDATION_FAILED", {
        detail: `File "${parsed.data.fileName}" must be a .csv or .xlsx statement.`,
        errors: [{ field: "fileName", message: "must be a .csv or .xlsx statement file" }],
      }),
    );
  }
  try {
    const limit = parsed.data.previewRows ?? 5;
    const build = (
      table: {
        headers: string[];
        rows: Array<{ rowNumber: number; cells: string[] }>;
        errors: Array<{ rowNumber: number; message: string }>;
      },
      delimiter: string | null,
    ): PreviewResponse => {
      const detected: DetectedMapping = detectColumnMapping(table.headers);
      return {
        importId: parsed.data.importId,
        dataSourceId: provisionalSourceId(workspaceId, extension),
        fileName: parsed.data.fileName,
        kind: extension,
        delimiter,
        headers: table.headers,
        preview: table.rows
          .slice(0, limit)
          .map((r) => ({ rowNumber: r.rowNumber, cells: r.cells })),
        totalRows: table.rows.length,
        parseErrors: table.errors,
        mapping: detected.mapping,
        confidence: detected.confidence,
        unmapped: detected.unmapped,
        suggestedAccount: suggestedAccountFor(parsed.data.fileName),
      };
    };
    if (extension === "csv") {
      const table = parseCsvBytes(bytes);
      return NextResponse.json(build(table, table.delimiter));
    }
    return NextResponse.json(build(await parseXlsxBytes(bytes), null));
  } catch (error) {
    if (error instanceof DomainError) {
      return problemResponse(error);
    }
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
