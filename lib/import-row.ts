import { createHash } from "node:crypto";
import { normalizeCategoryName, resolveMerchantName, type MappedRow } from "@/lib/csv";
import { calendarDayBoundary } from "@/lib/finance/calendar";

// Stable IDs make every canonical effect safe to retry after a partial workflow failure.
export function stableId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function importRowPayload(workspaceId: string, importId: string, row: MappedRow) {
  const sourceId = stableId(`${importId}:row:${row.rowNumber}`);
  const feeEvidence = row.feeEvidence ? { ...row.feeEvidence, ...(row.feeMinor !== undefined ? { feeMinor: row.feeMinor.toString() } : {}), ...(row.feeEvidence.deltaMinor !== undefined ? { deltaMinor: row.feeEvidence.deltaMinor.toString() } : {}) } : null;
  const merchantName = resolveMerchantName(row.merchant, row.description);
  const categoryName = normalizeCategoryName(row.category);
  return { sourceId, accountName: row.accountName, balanceId: stableId(`${importId}:balance:${row.rowNumber}`), rowNumber: row.rowNumber, calendarTimezone: row.calendarTimezone ?? null, sourceType: row.sourceType ?? null, feeMinor: row.feeMinor?.toString() ?? null, originalRow: row.sourceRow,
    externalId: row.externalId ?? null, reviewReasons: row.reviewReasons, feeEvidence,
    postedOn: row.postedOn, postedAt: row.postedAt ?? null, description: row.description, amountMinor: row.amountMinor.toString(), currencyCode: row.currencyCode,
    status: row.status, kind: row.kind, merchantName, merchantNormalizedName: merchantName?.toLowerCase() ?? null, merchantId: merchantName ? stableId(`${workspaceId}:merchant:${merchantName.toLowerCase()}`) : null,
    categoryName, categoryId: categoryName ? stableId(`${workspaceId}:category:${categoryName}`) : null,
    balanceMinor: row.balanceMinor?.toString() ?? null, balanceAsOf: row.balanceMinor !== undefined ? row.postedAt ?? calendarDayBoundary(row.postedOn, row.calendarTimezone) : null };
}
