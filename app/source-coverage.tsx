import type { SourceCoverage } from "@/lib/finance/source-coverage";
export function SourceCoverageDetails({ coverage }: { coverage: SourceCoverage }) {
  const { scope } = coverage;
  const period = scope.from === "0001-01-01" ? `All recorded history up to ${scope.to}` : `${scope.from} to ${scope.to}`;
  const unresolved = coverage.unresolvedSourceRows;
  return <details className="text-sm text-muted-foreground">
    <summary className="cursor-pointer select-none hover:text-foreground">How this was calculated</summary>
    <ul className="mt-3 space-y-2">
      <li>{period}{scope.currencyCode ? ` in ${scope.currencyCode}` : ", with each currency kept separate"}.</li>
      <li>Based on {coverage.includedRows} of {coverage.acceptedEffectiveRows} accepted transactions.</li>
      {scope.recordBasis && <li>Uses {scope.recordBasis === "manual_wealth" ? "valuations you entered by date" : "savings and goal reservations you entered by date"}.</li>}
      {coverage.observedSourceRows === null
        ? <li>Imported files were not checked for this result.</li>
        : <li>{unresolved === 0 ? "Every imported row is accounted for." : `${unresolved} imported ${unresolved === 1 ? "row still needs" : "rows still need"} review.`}</li>}
      <li>Gaps between statements are unknown, so these totals may be incomplete.</li>
    </ul>
  </details>;
}
