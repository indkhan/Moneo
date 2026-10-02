# Moneo QA baseline for completion work

Recorded on 2026-10-01 against repository revision `4d90ee4`, before application implementation changes. This is the starting evidence for `orchestrator-prompt.md`. Reproduce the findings against the current revision; distinguish defects, missing features, test drift, and unverified behavior.

## Environment and method

The existing Vercel login/import pages were opened in the collaborative browser. Authenticated acceptance used the local running application connected to the configured Supabase, with a newly created disposable test user/workspace. Test sign-in used the existing Supabase admin/auth APIs without sending email or adding a production auth bypass. Selected form actions were submitted through the browser DOM when focused automation clicks did not reliably submit off-screen controls.

Both supplied root-level CSVs were exercised locally. Their contents, monetary totals, account identifiers, and filenames are deliberately absent from this report. Keep the original statements private and uncommitted. Server-only credentials and auth state were not added to source files.

## Baseline automated checks

| Check | Actual result | Limit |
| --- | --- | --- |
| `npm test` | 18 files, 98 tests passed | Existing coverage does not exercise every requirement or the findings below. |
| `npm run lint` | Passed | Does not establish financial correctness. |
| `npm run build` | Passed, including TypeScript and workflow build | Local build, not deployed authenticated acceptance. |
| `npm run test:e2e` without auth state | 8 passed, 1 skipped | Live authenticated journey was explicitly skipped. |
| `npm run test:e2e -- e2e/core-journey.gated.spec.ts --output=test-results/gated` with disposable auth state | 1 failed | Import completed; test then failed on an obsolete Home heading locator. Later steps did not execute in this run. |
| Temporary targeted finance assertions | 3 assertions failed, reproducing the currency findings below | The goal test mocked host SDK data. Temporary test was removed after recording results; these are not additional passing baseline tests. |

The gated journey fails at `e2e/core-journey.gated.spec.ts:112`, which expects a heading named Net worth. Home currently renders the metric label as a paragraph. Other assertions refer to the old Plan/Available-to-spend headings and old transaction-count wording. Update assertions to prove intended behavior; do not merely remove them to obtain a green test.

## Successful live checks

- Synthetic authenticated CSV import completed, persisted two transactions, and started a financial review that completed and saved its result.
- The supplied semicolon-delimited German statement parsed and imported 169 rows. The supplied timestamp-based statement parsed and imported 426 rows. Both finished with zero rejected/review/matched rows and no workflow error using explicit reviewed mappings. Automatic AI mapping for the timestamp-based statement produced a valid preview.
- Independently calculated signed source totals matched persisted transaction totals for both supplied files. Source-record counts and linked ledger counts matched 169 and 426 respectively. This establishes amount preservation, not correct spending/account interpretation.
- Byte-identical reuploads returned the existing import IDs, rather than duplicating transactions. Import undo previews reported the expected 169/426 deletable transactions and no blockers before subsequent test edits. Actual full-file undo was not exercised.
- Created a goal through the Plan interface. Set known manual test balances of EUR 1000, EUR 5000, and EUR 1000. With no scheduled assumptions/reservations, available-to-spend was EUR 7000. Allocating EUR 500 to the goal reduced available-to-spend to EUR 6500.
- Submitted a category correction and undo through the actual transaction form/server actions. Database correction history recorded the change and its undone state.
- Created a trusted spending tool, opened it, pinned it to Home, and executed its existing code in the browser QuickJS worker. The runtime returned the expected ready result. This did not verify AI-generated code, export, or version restoration.
- A live grounded chat request returned HTTP 200 and an answer using account/balance information. This confirms the configured provider path operates, not that all generated explanations are semantically correct.
- Anonymous Supabase transaction reads returned no rows; anonymous import-detail API access returned 401. Full two-user isolation was not exercised.

## Reproduced import interpretation gaps

### Mixed products become one account

The 426-row statement contains two products: 369 Current rows and 57 Savings rows. The existing mapping has one account name and no per-row product/account routing. All 426 rows persisted into one account. Balance snapshots from both products therefore belong to that combined account. A successful import must not be treated as a reconciled current/savings financial model.

Evidence: supplied source Product counts; persisted distinct account count of one; mapping schema in `lib/csv.ts`; account selection in `workflows/import-file.ts`.

### Explicit financial types are lost

All imported rows in both files were persisted as `ordinary`. The 426-row source includes Transfer, Card Refund, Exchange, and other types. It contains 176 Transfer rows and four Card Refund rows. It also has one nonzero Fee field. Mapping has no transaction-kind or fee column support.

Not every row labeled Transfer is necessarily an internal movement. The needed behavior is evidence-backed classification/linking and review, rather than treating every transfer as income/spending or blindly suppressing all transfer rows. Verify fee inclusion against source balance deltas before deciding whether a separate fee record would double count.

### Source status vocabulary cannot be mapped

Supplying `statusColumn: "State"` for the 426-row statement to the actual inspect endpoint returned HTTP 400: `Row 2: Invalid status: COMPLETED`. All rows use COMPLETED. The existing automatic mapping omitted this column and imported them as posted, which is valid for this particular file but does not solve provider status normalization generally.

Evidence: `parseTransactionStatus` in `lib/csv.ts` accepts only posted/pending; explicit inspect request reproduced the error. Introduce validated mapping/normalization with review for unsupported states, rather than silently coercing future failed/reverted/pending transactions.

### Progress is only persisted at chunk boundaries

During the real larger imports, canonical/source rows were already being persisted while import history still reported `new_rows: 0`. The counter advanced at the 250-row chunk boundary and final completion. Both imports eventually completed. This is coarse progress and a long-running work concern, not proof of a hung workflow.

Evidence: running import rows versus independently queried persisted transaction count; `processImport` in `workflows/import-file.ts`. Measure throughput and preserve retry/idempotency before changing batching/progress.

## Reproduced shared finance currency findings

### Excluded foreign rows invalidate cashflow

Calling `summarizeCashflow` with a posted EUR expense of `-1000n` plus either a USD pending row or a posted USD transfer returned `null`. Under the stated rule that pending/transfer rows do not contribute to cashflow, expected EUR totals are income `0n`, spending `1000n`, net `-1000n`.

Evidence: temporary targeted Vitest assertions against the real helper; `lib/finance/calculations.ts:17` checks currency before excluding rows at line 21. Existing callers may prefilter currencies; reproduce affected application paths before choosing severity or changing the helper contract.

### Goal calculator snapshot mislabels currency

With host SDK data for a USD goal of 10000 minor units and a 2500 allocation, `buildCalculatorSnapshot` retained amounts and remaining 7500 but emitted `currency: "EUR"`. This was reproduced at the real snapshot function with mocked SDK data, not via a live USD goal.

Evidence: `lib/artifacts/snapshot.ts:81` drops goal currency, and lines 92/94 hardcode EUR. Preserve per-goal currency or perform an evidenced conversion; never aggregate unconverted currencies.

## Static findings requiring reproduction

These are code-review findings, not claims of completed live reproduction.

| Concern | Source evidence | Required acceptance |
| --- | --- | --- |
| Transaction-link corrections do not propagate to confirmed recurring assumptions | Transfer/refund migration 011 updates transactions/correction history; forecast in `lib/finance/model.ts` reads `financial_assumptions` | Confirm a series, correct its evidence to internal transfers, then reevaluate and undo. Preserve intentional user overrides. |
| Historical snapshot reused as today's forecast opening balance | `lib/finance/model.ts:77,110` | Reconcile posted activity after snapshot boundaries, or expose missing/current-balance uncertainty. Avoid double counting and future snapshots. |
| Daily generated spending chart and full-period total use different data coverage | `lib/artifacts/finance-sdk.ts:27` caps ordinary rows at 50; `lib/artifacts/snapshot.ts:41` builds daily values from them | Full-period daily aggregation, refund/transfer consistency, clear query/filter semantics. |
| Drizzle schema lacks deployed tables and a changed deletion rule | Migrations 014/018 add `spending_plans`/`transaction_views`; migration 019 adds recurring assumption `ON DELETE SET NULL`; `lib/db/schema.ts` lacks matching definitions | Introspect fresh/upgraded databases and align schema. |
| Planning edits/removals lack audit/undo | `app/plan/actions.ts` directly updates/deletes assumptions | Verify goals, allocations, assumptions, scenarios, budgets, and relevant model controls have appropriate reversible history. |
| Financial reviews lack detailed goal/category/forecast evidence | `workflows/financial-review.ts` and `lib/finance/review.ts` provide balances and aggregate 90-day cashflow | Goal-relevant investigations, source links, comparable periods, evidence freshness, historical review retention. |
| Chat cancellation and write targeting are incomplete | `app/api/chat/route.ts`, `app/ai/chat-form.tsx`, `lib/ai/write-intent.ts` | Cancellation, ambiguous matching, adversarial commands, duplicate/concurrent requests, and no writes after effective cancellation. |
| Balance readers have differing date/tie rules | `lib/finance/tools.ts`, `lib/finance/model.ts`, `lib/finance/review.ts` | One consistent evidenced rule across Home, AI, forecasts, goals, and tools. |
| Calendar-month rules use UTC despite Germany-first defaults | `lib/finance/spending-plans.ts`, `lib/artifacts/finance-sdk.ts`, `lib/finance/model.ts` | Europe/Berlin period boundaries, DST, month-end recurrence, leap years. |
| Transfers/refunds assume same-currency matching | Migration 011 and transaction detail controls | Cross-currency legs, partial/multiple refunds, fees, dated FX evidence, unmatched legs, undo. |

## Remaining product scope

Complete Home's overview/customization; manual and bulk transaction workflows; tags/splits/events; dedicated investments/assets/debt; richer goals/planning history; central model controls; user settings/permissions/usage; selective configurable insights; scheduled in-app summaries; broader generated tools and PDF/image exports. Bank connections remain outside this import-first completion phase.

Follow `orchestrator-prompt.md` for the owner's settled decisions. Do not treat this list as permission to skip unmentioned clauses in `plan.md`.

## Limits of this baseline

No complete authenticated Vercel acceptance was performed. The full E2E journey still fails on test drift, and subsequent steps were explored separately rather than passed as one integrated suite. Two-user RLS, cross-currency links, overlap resolution, workflow cancellation/resume, invalid artifact revisions/restore, full import undo, schedules, exports, and complete mobile/accessibility QA remain unverified. A temporary width overflow appeared immediately after viewport resize and disappeared after layout settled; it was not established as a persistent application defect.

Temporary detailed logs were kept only in ignored locations. The disposable workspace, user, and three uploaded storage objects were removed after the checks; unrelated workspaces were left untouched. Temporary auth files and helper processes were cleaned up. The original CSVs were preserved.
