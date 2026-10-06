// Bounded SDK inputs keep generated-code memory limits intact. Counts always
// describe the complete host result, before truncation.
export const SNAPSHOT_LIMITS = { balances: 50, goals: 20 } as const;
export type SnapshotCoverage = Partial<Record<keyof typeof SNAPSHOT_LIMITS, { total: number; included: number; truncated: boolean }>>;

export function evidenceCoverage(total: number, operation: keyof typeof SNAPSHOT_LIMITS) {
  const included = Math.min(total, SNAPSHOT_LIMITS[operation]);
  return { total, included, truncated: included < total };
}

export function coverageWarnings(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== "object" || !("coverage" in snapshot) || !snapshot.coverage || typeof snapshot.coverage !== "object") return [];
  return Object.entries(snapshot.coverage).flatMap(([operation, value]) => {
    if (!value || typeof value !== "object" || !("truncated" in value) || value.truncated !== true || !("included" in value) || !("total" in value) || typeof value.included !== "number" || typeof value.total !== "number") return [];
    return [`Input coverage: ${value.included} of ${value.total} ${operation}. Remaining records are excluded from this calculator.`];
  });
}
