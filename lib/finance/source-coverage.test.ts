import { expect, it } from "vitest";
import { buildSourceCoverage } from "./source-coverage";

const scope = { from: "2026-10-01", to: "2026-10-31", currencyCode: "EUR" };
const rows = [{ account_id: "a", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [] }];
const imports = [{ id: "i", status: "completed", total_rows: 2 }];
const source = (status: string) => ({ import_id: "i", status, posted_on: "2026-10-01", currency_code: "EUR", account_id: "a" });

it("does not call an accepted exact total complete while an overlap observation is unresolved", () => {
  const result = buildSourceCoverage(scope, rows, imports, [source("new"), source("review")]);
  expect(result).toMatchObject({ acceptedEffectiveRows: 1, includedRows: 1, observedSourceRows: 2,
    unresolvedSourceRows: 1, financialCompleteness: "unknown", statementIntervals: null,
    limitations: expect.arrayContaining(["unresolved_source_observations", "statement_intervals_unknown"]) });
  expect(buildSourceCoverage(scope, rows, imports, [source("new"), source("matched")])).toMatchObject({ unresolvedSourceRows: 0, matchedSourceRows: 1, acceptedEffectiveRows: 1 });
  expect(buildSourceCoverage(scope, [...rows, ...rows], imports, [source("new"), source("new")])).toMatchObject({ acceptedEffectiveRows: 2, includedRows: 2 });
});

it("keeps unknown source scope, import lifecycle, undo and row exclusions explicit", () => {
  const result = buildSourceCoverage(scope, [...rows, { ...rows[0], status: "pending" }, { ...rows[0], kind: "transfer" }, { ...rows[0], review_reasons: ["source_type"] }],
    [...imports, { id: "running", status: "running", total_rows: 10 }, { id: "failed", status: "failed", total_rows: 4 }, { id: "undone", status: "undone", total_rows: 1 }],
    [source("new"), { ...source("review"), posted_on: null }, { ...source("review"), posted_on: "2026-09-01" }, { ...source("review"), import_id: "undone" }]);
  expect(result).toMatchObject({ unresolvedSourceRows: 1, unknownSourceScopeRows: 1, undoneSourceRows: 1,
    exclusions: { pending: 1, transfer: 1, classification: 1 }, importStatuses: { completed: 1, running: 1, failed: 1, undone: 1 } });
  expect(buildSourceCoverage(scope, rows)).toMatchObject({ observedSourceRows: null, unresolvedSourceRows: null,
    limitations: expect.arrayContaining(["source_access_unavailable"]) });
});
