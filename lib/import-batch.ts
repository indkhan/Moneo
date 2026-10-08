import type { MappedRow } from "./csv";
import { importRowPayload, stableId } from "./import-row";
import { decideImportMatch } from "./import-match";
import { z } from "zod";

type Excluded = { rowNumber: number; sourceRow: Record<string, unknown>; reason: string };
export const IMPORT_BATCH_ROWS = 250;
export const IMPORT_STAGE_BYTES = 64_000_000;
export const candidateRowsSchema = z.array(z.object({ rowNumber: z.number().int().min(2), hasExternalId: z.boolean(), status: z.enum(["posted", "pending"]), candidates: z.array(z.object({ id: z.string().max(36), stableExternalMatch: z.boolean(), status: z.enum(["posted", "pending"]), version: z.number().int().nonnegative() })).max(1000) })).max(IMPORT_BATCH_ROWS);
type CandidateRow = z.input<typeof candidateRowsSchema>[number];
export function stageImportRows(workspaceId: string, importId: string, mapped: MappedRow[], excluded: Excluded[], accounts: Map<string, string>, total: number) {
  if (!Number.isInteger(total) || total < 0 || total > 10_000 || mapped.length + excluded.length !== total) throw new Error("Normalized import coverage differs from reviewed rows");
  const rows = [...mapped.map(row => {
    const accountId = accounts.get(JSON.stringify([row.accountName, row.currencyCode]));
    if (!accountId) throw new Error("Normalized import route is unavailable");
    return { accountId, excluded: false, row: importRowPayload(workspaceId, importId, row) as Record<string, unknown> };
  }), ...excluded.map(row => ({ accountId: null, excluded: true, row: { sourceId: stableId(`${importId}:row:${row.rowNumber}`), rowNumber: row.rowNumber, originalRow: row.sourceRow, reason: row.reason } as Record<string, unknown> }))].sort((a, b) => Number(a.row.rowNumber) - Number(b.row.rowNumber));
  if (rows.some((row, index) => row.row.rowNumber !== index + 2)) throw new Error("Normalized import coverage differs from reviewed rows");
  if (Buffer.byteLength(JSON.stringify(rows), "utf8") > IMPORT_STAGE_BYTES) throw new Error("Normalized import exceeds the 64 MB staging limit");
  return rows;
}
export function batchDecisions(rows: CandidateRow[]) {
  return candidateRowsSchema.parse(rows).map(row => {
    // Only equality evidence is needed by the existing decision helper. Keep
    // arbitrary original external IDs in staging/source history, not repeated
    // up to 1,000 times in every candidate response.
    const decision = decideImportMatch(row.hasExternalId ? "stable" : undefined, row.candidates.map(candidate => ({ ...candidate, externalId: candidate.stableExternalMatch ? "stable" : undefined })), row.status);
    return { rowNumber: row.rowNumber, ...decision, ...(decision.action === "matched" ? { expectedTransactionVersion: row.candidates.find(candidate => candidate.id === decision.transactionId)!.version } : {}) };
  });
}
