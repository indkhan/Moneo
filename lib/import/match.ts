// Candidates must come from earlier imports of the same account and currency.
// Pending and posted never merge: a stable external-ID match only counts when
// the stored status equals the incoming row status (missing status reads as
// posted for legacy rows). Any other fingerprint overlap goes to review so a
// pending hold and its later posted settlement cannot collapse or duplicate.
/**
 * A row with no transaction ID from a bank's complete answer for that date. The bank states `total` identical rows and this
 * is number `index`, so the ledger's canonical rows are matched one to one, and rows beyond them are real further payments.
 * Fewer stated than the ledger has, or a candidate in another state, is unclear and goes to review.
 */
export function decideOccurrence(rowStatus: "posted" | "pending", occurrence: { index: number; total: number }, candidates: { id: string; status?: string }[]):
  | { action: "new" | "review" }
  | { action: "matched"; transactionId: string } {
  // Each canonical row counts once, however many source copies led to it.
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
