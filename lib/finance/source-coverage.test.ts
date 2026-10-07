import { expect, it } from "vitest";
import { buildSourceCoverage, loadSourceCoverage, sourceCoverageNeedsReview } from "./source-coverage";
import type { SupabaseClient } from "@supabase/supabase-js";

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
  const accepted = buildSourceCoverage(scope, [...rows, ...rows], imports, [source("new"), source("accepted")]);
  expect(accepted).toMatchObject({ acceptedEffectiveRows: 2, includedRows: 2, unresolvedSourceRows: 0 });
  expect(sourceCoverageNeedsReview(accepted)).toBe(false);
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

it("distinguishes resolved rejected observations and deliberate nonfinancial row exclusions from unresolved review", () => {
  const rejected = buildSourceCoverage(scope, rows, [{ ...imports[0], total_rows: 1 }], [source("rejected")]);
  expect(sourceCoverageNeedsReview(rejected)).toBe(false);
  const excluded = buildSourceCoverage(scope, rows, [{ ...imports[0], total_rows: 1 }], [{ ...source("rejected"), posted_on: null, currency_code: null, account_id: null, review_reasons: ["excluded_by_review"] }]);
  expect(excluded).toMatchObject({ intentionallyExcludedSourceRows: 1, unknownSourceScopeRows: 0, unresolvedSourceRows: 0 });
  expect(sourceCoverageNeedsReview(excluded)).toBe(false);
});

it("keeps balance activity separate from spending eligibility and uses the reviewed destination scope", () => {
  const coverage = buildSourceCoverage({ ...scope, accountId: "reviewed", ledgerBasis: "balance_activity" },
    [{ ...rows[0], account_id: "reviewed", kind: "transfer", review_reasons: ["source_type"] }],
    [{ ...imports[0], total_rows: 1 }], [{ ...source("accepted"), resolved_account_id: "reviewed" }]);
  expect(coverage).toMatchObject({ includedRows: 1, exclusions: { transfer: 0, classification: 0 }, observedSourceRows: 1,
    scope: { accountId: "reviewed", ledgerBasis: "balance_activity" } });
});

it("never reads denied source data and scopes/project-only metadata for permitted paged reads", async () => {
  const calls: unknown[][] = [];
  const from = (table: string) => {
    const query = { select: (columns: string) => { calls.push(["select", table, columns]); return query; },
      eq: (field: string, value: string) => { calls.push(["eq", table, field, value]); return query; }, order: () => query,
      range: async (start: number) => ({ data: table === "imports" ? imports : start === 0 ? Array.from({ length: 500 }, () => source("new")) : [source("review")], error: null }) };
    return query;
  };
  const db = { from } as unknown as SupabaseClient;
  expect((await loadSourceCoverage(db, "w", scope, rows, false)).observedSourceRows).toBeNull();
  expect(calls).toEqual([]);
  expect(await loadSourceCoverage(db, "w", scope, rows, true)).toMatchObject({ observedSourceRows: 501, unresolvedSourceRows: 1 });
  expect(calls).toContainEqual(["eq", "imports", "workspace_id", "w"]);
  expect(calls).toContainEqual(["eq", "source_transactions", "workspace_id", "w"]);
  expect(calls.filter(call => call[0] === "select").map(call => call[2]).join(" ")).not.toMatch(/original_row|mapping|description|amount|filename/);
});
