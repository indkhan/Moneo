export function resolveEvidenceRef(evidenceRef: string, eligibleTransactionIds: ReadonlySet<string>): { filters: Record<string, unknown>; transactionIds: string[] } | null {
  if (!evidenceRef.startsWith("ev_")) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(evidenceRef.slice(3), "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || !Array.isArray((value as { ids?: unknown }).ids) || typeof (value as { filters?: unknown }).filters !== "object" || (value as { filters: unknown }).filters === null) return null;
    const ids = (value as { ids: unknown[] }).ids;
    if (!ids.every((id): id is string => typeof id === "string" && eligibleTransactionIds.has(id))) return null;
    return { filters: (value as { filters: Record<string, unknown> }).filters, transactionIds: ids };
  } catch { return null; }
}
