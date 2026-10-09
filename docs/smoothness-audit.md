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

## Final audit follow-through on 8 October 2026

Commit `b629fd0` closes the UUID advisory with an ExcelJS-scoped override to CommonJS-compatible UUID 11.1.1. A buffer-bounds regression failed before the update and passed afterward; an actual XLSX extended conditional-formatting roundtrip verifies the dependency's UUID v4 path. `npm audit --omit=dev` reports zero vulnerabilities. Full dependency auditing now reports five high package entries from the single [unpatched braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), confined to the ESLint development dependency chain. The advisory lists no patched version; this remains the explicit upstream exception.

Fresh rollback-only verification passed all 67 repository migrations and 48 SQL regressions, with fresh and upgraded schema parity. The first required unit run exposed a fixture deadlock: live test files concurrently replayed DDL and wrote shared auth/workspace tables. Commit `7d99e43` serializes files in the required tier while retaining deliberate concurrency within tests. The complete unit suite then passed all 1,114 tests across 192 files with every live database gate enabled and zero skips. ESLint and the production build also passed after the dependency update.

Commit `d2b859d` updates the budget browser assertion to the current accepted-record carry/allowance wording while retaining the unknown financial-completeness warning. This corrects stale test expectations without changing financial behavior.

The complete deterministic authenticated browser run executed 73 tests: 70 passed, three failed, with zero skips or flaky results. The failures exposed the stale budget wording above, a recurring helper accepting an older balance review as proof of a newer save, and an isolation test expecting immediate terminal cancellation of a synthetic job without a worker. Commit `ef6d5c3` binds the recurring helper to the exact saved request, reviewed transaction evidence and refreshed form. Commit `86f9abe` verifies the owner Stop request persists while a foreign request cannot change it; worker acknowledgment remains a separate state.

All seven tests in the three affected specs then passed with zero skips or flaky results, including all five recurring cadences, budget persistence/undo, and two-user isolation. Every one of the 73 browser cases therefore has passing evidence with the final assertions, across the full run and targeted rerun. The first `acceptance:required` invocation stopped at the fixture deadlock; its migration, complete live-unit and complete browser components were subsequently verified separately after the fixes. This is not a claim that a single final required-tier invocation passed or that deployment/provider evaluation was performed. Final ESLint passed. Detailed evidence remains ignored under `.qa/audit-finish-*`.

The audit's disposable user/workspace, their exact imported storage objects and saved authentication state were removed after verification. Cleanup verified that both the user and workspace were absent; the ignored recovery journal retains the completed status.

## Fresh application journey on 9 October 2026

A fresh disposable account exercised sign-in feedback, empty-workspace rendering, account creation, a manual exact EUR posting, correction history and undo. Parallel checks found two application bugs: sign-in exceptions left users without feedback and allowed duplicate submissions, and UTF-16 truncation could split a Unicode merchant character and make Postgres reject an import. Commits `fa930c0`, `7606936` and `ec4b0c8` fix these paths while retaining original sources. Commit `99bdbc3` pins the liquidity adapter tests to their fixed forecast-evidence date; advancing the real clock had correctly triggered the production horizon guard against stale test evidence.

The complete unit suite passed 1,120 tests across 193 files with all four live database gates enabled and zero skips. ESLint and the production build passed. Eleven selected browser cases have passing final evidence: sign-in pending/error/retry, a real Unicode import through preview/confirmation/Workflow/Postgres, manual entries and bulk/split history undo/restore, custom tool versions/restore/exact output/PNG export, goal plans, forecast preferences, scenario edits/history/undo, and four unauthenticated startup smoke cases. The new import test first failed on its own selector, which was corrected before its passing rerun. These are selected journey checks, not a fresh execution of every required-tier browser case.

Sign-in email delivery and initial import model suggestions were intercepted; paid model/provider execution was not exercised. The explicit corrected import, durable worker and persisted source/amount were real. The exact disposable workspace, user, imported storage objects and saved authentication were removed and verified absent after the journey. Detailed evidence remains ignored under `.qa/journey-*`.

After the build, the production server started successfully and all four startup smoke cases passed again against it. The local application was left running on port 3000 with its normal environment configuration.

## Thorough user-flow follow-through on 9 October 2026

Repeated journeys through disposable workspaces found and fixed nine additional application bugs:

| User-visible problem | Fix |
| --- | --- |
| Valid Unicode source categories could disappear during import. | Count Unicode characters consistently with the database limit and preserve the original source. |
| Failed sign-in callbacks returned to Login without an explanation. | Explain the failed link and retain the retry path. |
| Unresolved transfers disappeared from financial uncertainty. | Retain classification exclusions and mark totals partial before excluding confirmed transfer principal. |
| Typing the next question while an answer arrived could erase that draft. | Preserve changed drafts through both the assistant panel and first saved-conversation navigation. |
| Rejected Settings submissions reset the user's edits. | Retain the editable draft while showing validation errors. |
| Verified empty account inventories became generic clarification questions. | Render the recorded absence from an owned, accounts-scoped receipt. |
| Settings rejected working reasoning models because its probe exhausted 64 output tokens. | Allow a bounded 512-token probe while retaining the timeout, free-price restrictions and empty-response rejection. |
| Long account names and native select options widened mobile screens. | Allow cards to shrink, wrap long text and bound select widths. An explicit long-name fixture exercises eight routes at 360 px, dark appearance and keyboard dismissal. |
| Verified nonempty account inventories also became generic questions. | Render validated, escaped account names from the retained owned receipt with evidence links; infer no balances. |

The publication checks retain rejection of malformed, foreign and unpermitted evidence, and of unsupported provider prose. Installed Zod 4 already counts Unicode characters correctly; separate inventory regressions cover the 120/121-character boundary without duplicating validation code. Financial calculations, money precision, original sources, history and sandbox boundaries remain intact.

The public production alias is `https://moneo-mu.vercel.app`. Live disposable-workspace checks exercised account creation, an exact EUR 12.34 manual posting, correction and undo, explicit booked-balance review, goal reservation and undo, and an actual EUR 23.45 file import through the durable worker with its Unicode merchant retained. The production API key also completed a verified-free model probe and an actual account-reader call. Free-provider rate limits remain observable external failures; no paid calls were enabled. Sign-in email delivery is intercepted in browser regressions, so these checks do not establish SMTP delivery.

Release acceptance now uses a fresh production server. A traced development hot reload returned stale page data while a correct recurring-payment action completed; production acceptance avoids that HMR race. The required gate checks that the latest successful, clean fast run matches both the current Git revision and production build ID, disables the provider key for deterministic browser cases, and rejects skips or flaky results. Configurable browser targets also use matching authentication-cookie hostnames.

Full reports, traces, screenshots, synthetic authentication and cleanup journals remain ignored under `.qa`. Disposable identities and storage objects are checked by exact ownership before cleanup. Required acceptance must start with a fresh workspace; reusing an earlier failed run can contaminate later currency and period assumptions. The standalone live-provider journey remains separate from the deterministic release gate.

The fresh production-server run on `256ff23` passed 1,146 live unit tests and 74 of 79 browser cases, with no skips or flaky results. The failures exposed two further calculator problems: production server-action redaction hid expected input validation, and failed or stopped previews retained a recalculating banner. Expected account, amount, date, currency and horizon validation now returns safe structured feedback; rejected drafts remain editable. Authentication, database and stored-manifest failures retain exception redaction. Terminal previews stop displaying the loading banner.

Traces also identified a recurring test navigating away before its Enable action finished; it now waits for the saved enabled state. Read-only measurements found the database clock 860–900 ms ahead of local Node time. Synthetic balance fixtures now share a deliberate evaluation clock or use the start of the Berlin calendar day, preserving production exclusion of future records. Explicit cloud action waits retain the exact status, amount, history and undo assertions.

The deployed `256ff23` additionally passed real artifact execution/save and booked-balance review/undo checks. A real Dots account-reader response returned the recorded account names and a current retained evidence link. These prove the selected workspace model and production API key work; they do not establish that Vercel's separate production default has changed. Its health response still reported `stealth/space-bunny-alpha` after that deployment, pending authenticated dashboard access.
