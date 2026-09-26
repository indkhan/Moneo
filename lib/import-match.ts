// Candidates must come from earlier imports of the same account and currency.
export function decideImportMatch(externalId: string | undefined, candidates: { id: string; externalId?: string }[]):
  | { action: "new" | "review" }
  | { action: "matched"; transactionId: string } {
  const stableMatches = externalId ? candidates.filter(candidate => candidate.externalId === externalId) : [];
  if (stableMatches.length === 1) return { action: "matched", transactionId: stableMatches[0].id };
  if (!candidates.length) return { action: "new" };
  return { action: "review" };
}
