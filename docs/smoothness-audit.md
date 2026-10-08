# Moneo reliability and smoothness audit

Verified locally on 4 October 2026 using the configured Supabase project, disposable authenticated workspaces, real statement files, and synthetic calculator artifacts. Fixes were committed individually.

| Finding | Fix and evidence |
| --- | --- |
| Home waited for independent database reads in sequence. | Run independent reads together; retain explicit errors. |
| Home recalculated balance and wealth evidence for its forecast. | Reuse the same in-flight evidence and workspace context. Regression coverage verifies shared results. |
| Forecast reservations, assumptions, FX and scenarios silently stopped at the API row limit. | Fetch every page. A 1,001-row reservation regression verifies the financial total. |
| Opening ordinary pages loaded the assistant and source editor unnecessarily. | Load the assistant on first open and CodeMirror when needed; retain chat history and an editor placeholder. |
| Editor extensions were rebuilt on every keystroke. | Stabilize extensions and callbacks. |
| Navigation lacked immediate loading feedback. | Add an accessible workspace loading boundary with reduced-motion support. |
| Source editing trapped Tab and lacked a useful accessible name. | Restore native keyboard navigation and label the editor. |
| Restoring a calculator version left its editor showing the newer source. | Synchronize source and manifest after restore. Browser regression covers edit/save/restore. |
| Calculator errors concealed trusted reasons why financial evidence was unavailable. | Show the snapshot's trusted availability reason. |
| Cancellation produced duplicate status announcements. | Give the live status role only to the active operation. Stop/recovery browser checks pass. |
| Supported statements unnecessarily waited for an AI mapping request. | Deterministic Revolut and bank mappings. Warm local inspection took 381 ms and 214 ms respectively; these are observations, not production guarantees. |
| Normal negative bank debit entries were unnecessarily flagged as unknown source types. | Recognize booked debits while retaining review for positive debits, transfers, cash and ambiguous evidence. |
| Duplicate CSV headers could silently change column interpretation. | Reject renamed/duplicate headers before mapping. |
| The upload picker was usable before its event handler hydrated. | Keep it disabled until hydration. A delayed-JavaScript browser regression verifies the boundary. |
| Uploading a previously undone file returned the old import without importing anything. | Active-only hash deduplication and a partial database unique index. Preserve old import/source/storage history and create a new run after undo. Real database and browser checks cover concurrent duplicates and reimport. |
| Local durable workflows could block the Node event loop during port discovery. | Disable diagnostic reverse DNS in local Node instrumentation while retaining endpoint ports. The same report probe dropped from about 29 seconds to 81 ms; a listening-socket regression verifies port discovery. |
| Internal workflow requests unnecessarily entered the Supabase session proxy. | Exclude the SDK's internal workflow route from that proxy. |

The Node report setting follows the documented [`process.report.excludeNetwork`](https://nodejs.org/api/report.html) behavior. No dependency patches, upgrades, sandbox weakening or financial-history deletion were required.

## Verification

- Unit suite: 287 passing tests across 79 files, including the configured live reservation database gate.
- ESLint: passed.
- Production build: passed.
- Browser suite: 41 of 42 passed on the first final run. The remaining test expected an undone history item to remain visible, contrary to the verified UI behavior. Its corrected, expanded real import-control flow passed separately, covering Stop, Resume, undo, fresh same-byte reimport, source retention and duplicate prevention. Every browser flow therefore passed with the final assertions.
- Calculator checks include exact integer output above JavaScript's safe-number range, sandbox/network boundaries, version restore, failed-save preservation, cancellation and print/export artifacts.
- Both real statement files were verified in an isolated workspace before the main import. The main-workspace parity check passed for every source row, amount, date, currency and account route; final counts are 595 transactions, three active accounts and 426 balance snapshots.

## Everyday workspace

The requested account's existing workspace receives 426 Revolut rows and 169 bank rows: 595 canonical transactions, three active EUR accounts and 426 balance snapshots. Revolut's source clock uses the explicitly confirmed Europe/Berlin timezone. Existing account identities are reused for Current and the bank; Savings has its own account.

Previous undone imports remain available as source history. The main-import helper's first Revolut routing mistake was undone through the application, then reimported with separate Current/Savings routes; the resulting empty helper account was archived. All disposable audit users/workspaces are removed after verification.

320 source-classification review flags remain intentional: the application cannot safely infer ownership or purpose of uncertain transfers and cash movements from these statements alone. They need user review before being treated as ordinary income/spending or paired transfers.

## Limits

These checks cover the supplied statements and the exercised user flows. They do not establish that every possible bug is gone, or that the changed code is deployed to production. Local development includes compilation overhead. No automated timing threshold claims a production page-speed improvement.

Private statement files, account details, authenticated cookies and detailed QA evidence stay out of Git. Local screenshots, print artifacts and logs are in the ignored `.qa` directory.

## Recheck on 8 October 2026

Three parallel checks revisited all 17 findings against the current code. The financial/import and runtime fixes remain implemented. One editor stability gap remained: `VersionEditor` supplied a new source callback on each render, causing CodeMirror to reconfigure while typing. Commit `dff62e4` stabilizes that callback; its regression failed before the fix and passed afterward.

Commit `4fd732e` adds bank/Revolut inspection regressions proving supported statements bypass the model even when import AI permissions are disabled. The focused finance/import suite passed 86 tests; a rollback-only database regression confirmed active-file deduplication, same-byte reimport after undo, and retained import/source history.

Commit `4077d66` updates supported dependency versions: Next.js and its ESLint config to 16.3.8, sharp to 0.35.5, http-cache-semantics to 4.3.0, and source-map-js to 1.2.2. The focused runtime/CSV/XLSX suite passed 64 tests. Final full validation passed 1,101 unit tests, ESLint, and the production build. The authenticated `manifest-input.gated.spec.ts` browser regression passed with its disposable user, covering restore, execution and saved inputs. Ten gated unit tests skipped; this is not full release acceptance.

`npm audit` still reports seven package entries from two underlying advisories: unpatched `braces` stack exhaustion in the ESLint development dependency chain (five high entries), and `uuid` buffer bounds handling in v3/v5/v6 (two moderate entries via ExcelJS). The installed ExcelJS uses UUID v4 without a supplied buffer, so no affected application call was identified. These advisories remain open; destructive downgrade suggestions were not applied. Deployment and the full authenticated browser suite remain separate acceptance gates.
