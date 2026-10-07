import type { SourceCoverage } from "@/lib/finance/source-coverage";
export function SourceCoverageDetails({ coverage }: { coverage: SourceCoverage }) {
  return <details className="mt-3 text-xs text-muted-foreground">
    <summary className="cursor-pointer">Source coverage · financial completeness unknown</summary>
    <div className="mt-2 space-y-1">
      <p>{coverage.scope.from === "0001-01-01" ? "Unknown opening boundary; all recorded history" : coverage.scope.from} to {coverage.scope.to}{coverage.scope.currencyCode ? ` · ${coverage.scope.currencyCode}` : " · currencies kept separate"}. {coverage.includedRows} included of {coverage.acceptedEffectiveRows} accepted effective rows.</p>
      <p>Row counts describe {coverage.rowCountScope}.</p>
      {coverage.scope.recordBasis && <p>This result uses {coverage.scope.recordBasis === "manual_wealth" ? "dated manual valuations" : "dated recorded savings and virtual reservations"}; import completeness is not evaluated for these manual records.</p>}
      {coverage.observedSourceRows === null ? <p>Source observations were not available or evaluated for this result; financial coverage remains unknown.</p> : <>
        <p>{coverage.observedSourceRows} source observations · {coverage.unresolvedSourceRows} unresolved source observation(s) · {coverage.matchedSourceRows} matched · {coverage.rejectedSourceRows} rejected · {coverage.undoneSourceRows} from undone imports excluded.</p>
        <p>{coverage.intentionallyExcludedSourceRows} intentionally excluded source rows; {coverage.excludedSourceScopeUnknownRows} have unknown period or account scope. Rejected and deliberately excluded rows are resolved exclusions.</p>
        <p>{coverage.unknownSourceScopeRows} observations have unknown period, currency or requested account scope.</p>
        <p>Workspace import status (period/account relevance may be unknown): {Object.entries(coverage.importStatuses ?? {}).map(([status, count]) => `${status}: ${count}`).join(", ") || "no recorded imports"}. {coverage.unobservedWorkspaceSourceRows} declared workspace rows have no recorded source observation.</p>
      </>}
      <p>Excluded effective rows: {Object.entries(coverage.exclusions).map(([reason, count]) => `${reason}: ${!coverage.lifecycleExclusionsKnown && ["pending", "transfer"].includes(reason) ? "not queried" : count}`).join(", ")}.</p>
      <p>Statement intervals and full account coverage are unknown. Reconciled-through date is unknown. Observed posting dates do not establish statement coverage.</p>
      <p>Exact included totals are neither upper nor lower bounds for the complete period.</p>
    </div>
  </details>;
}
