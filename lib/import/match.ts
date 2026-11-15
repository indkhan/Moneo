export function decideOccurrence(rowStatus: "posted" | "pending", occurrence: { index: number; total: number }, candidates: { id: string; status?: string }[]):
  | { action: "new" | "review" }
  | { action: "matched"; transactionId: string } {
  const ids = [...new Set(candidates.map(candidate => candidate.id))].sort();
  if (candidates.some(candidate => (candidate.status ?? "posted") !== rowStatus) || occurrence.total < ids.length) return { action: "review" };
  return occurrence.index <= ids.length ? { action: "matched", transactionId: ids[occurrence.index - 1] } : { action: "new" };
}

export function decideImportMatch(
  externalId: string | undefined,
  candidates: { id: string; externalId?: string; status?: string }[],
  rowStatus?: "posted" | "pending",
):
  | { action: "new" | "review" }
  | { action: "matched"; transactionId: string } {
  const normalizedRow = rowStatus ?? "posted";
  const stableMatches = externalId
    ? candidates.filter(candidate => candidate.externalId === externalId && (candidate.status ?? "posted") === normalizedRow)
    : [];
  if (stableMatches.length === 1) return { action: "matched", transactionId: stableMatches[0].id };
  if (!candidates.length) return { action: "new" };
  return { action: "review" };
}
