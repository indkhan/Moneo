// Candidates must come from earlier imports of the same account and currency.
// Pending and posted never merge: a stable external-ID match only counts when
// the stored status equals the incoming row status (missing status reads as
// posted for legacy rows). Any other fingerprint overlap goes to review so a
// pending hold and its later posted settlement cannot collapse or duplicate.
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
