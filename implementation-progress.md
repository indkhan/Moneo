# Implementation progress

Starting revision: `97f267b`; baseline audit: `4d90ee4`. Existing orchestrator edit and two private CSVs are preserved and excluded from staging. Bank connections remain deferred.

## Acceptance ledger

Items are incomplete until integrated checks and live evidence establish them. Existing behavior is not automatically accepted.

| Requirement / acceptance | Owner / dependency | State / evidence |
| --- | --- | --- |
| Reproduce unit/lint/build/browser baseline and gated drift | Root | Baseline reproduced:98 tests/18 files, lint/build pass; anonymous E2E8 pass/1 skip; authenticated heading failure reproduced then repaired journey1 pass. Deployed anonymous login redirect verified; collaborative snapshot failed twice |
| Explicit import product/account/currency routing, normalized statuses, private source totals, fees/type review | imports | `382a650`: fresh private routing/status/type/fee/timestamp/exact source totals and repeats pass; private downstream consumers and both actual full-file undos pass. Sources retained; original files private. |
| Import repeat/overlap, retry/resume/cancel/progress, preservation and undo | imports/root | Repeat IDs and both private full undos pass. Synthetic overlap/retry/resume/cancel integrated acceptance still required. |
| Cashflow exclusions, per-goal currencies, complete tool daily coverage | finance agent | Implementedcfba8d4;13 targeted tests; reviewed by schema agent. Pending classification partial labels integrated separately |
| Reconciled dated balances and shared tie/boundary rules; stale/missing labels | imports/root | Implemented conservative resolver and consumers;14 targeted tests plus Berlin manual-date regression. Source timestamp precision remains pending |
| Schema parity, fresh/upgraded migrations, RLS and workspace relationships | schema | Fresh/upgraded 46 migrations and28 SQL regressions pass; metadata/views/triggers/RLS and ORM alignment checked. Applied through049 (046 still pending implementation); final integrated rerun required. |
| Transfer/refund cross-currency, partial/multiple linking, fees, correction propagation, undo | finance | Applied041; actual browser PASS52.2s for dated EUR/USD principal+included fee+pair undo and two partial EUR refunds against USD original+each undo. Frozen comparison receipts and recurring invalidation SQL pass; legacy delete guard050 pending. |
| Home metrics, dates/provenance, persisted widgets/order and first review choices | root | `b75d113` persisted hide/order/pin shortcuts; actual browser reload/restore PASS6.9s. Dated balance/wealth/goal/forecast integrations verified separately; final integrated journey required. |
| Money manual/accounts/search/saved views/bulk/tags/splits/events/history | finance/schema | `356ce50` manual/bulk/tags/events and split028/035 actual browser/SQL pass; `4460f57` reversible archive/saved-view rename/remove/filter replacement, actual two-user browser PASS32s. Split/link coherent commit still pending integration. |
| Confirmed recurring effective dates/history; evidence corrections | finance | Reviewed source confirmation existed;041 now invalidates inferred assumptions on correction and conditionally restores on undo, preserving explicit user overrides. SQL evidence pass; integrated browser forecast propagation still required. |
| Investments quantities/prices/cost basis, assets dated values, debt schedules and liquidity separation | finance | `16684aa` exact fractional holdings/cost basis/gain, dated assets/debt schedules; actual browser2PASS15.2s. Separate cash/net worth and linked pending repayment regression pass. |
| Goals priority/contributions/affordability; no duplicate reservations | root | `545b906` recorded savings/contribution plans/completion and versioned reservations/history/undo. Actual browser2PASS15s; authenticated exact SQL liquidity/concurrency/date/undo guard cases pass. |
| Calendar budgets/rollover and plans; 12-month scenarios/cases/editable buffers | root | `7fe2f6e` editable buffers/uncertainty/explicit daily spending browserPASS5.8s; `5fedda6` recorded monthly budget targets/rollover browserPASS8.5s+exact SQL; `a4be2ab` scenario comparison/edit/remove/undo browserPASS19.9s with independent cash fixture. |
| Financial Model sources/assumptions/history; Berlin dates/DST/leap/month-end | root | Shared calendar/DST/leap/month-end regressions pass; financial assumptions/history/preferences editable. Central balance/valuation/FX source index currently integrating; `a6a3d72` FX Berlin-midnight regression pass. |
| Persistent contextual chat/reviews/tool library/activity; effective cancellation | Root |534c12b adds persisted chat states, atomic cancellation/write/reply guards;2 browser cancellation tests; actual concurrent duplicate/cancel SQL check passes. Review/tool generation cancellation still incomplete |
| Validated targeted AI writes, preview broad/destructive actions, idempotency/concurrency | Root | Exact UUID/quoted-category commands validated independently from model; ambiguous prose cannot grant model targets; DB+parser tests pass. Broader product impact previews pending |
| Settings currency/timezone/theme/models/scopes/usage/insights/summaries | schema/root | `a624159`/`65fe35c` profile/theme/free-model/scopes/usage/mutes/summary controls implemented; relevant scoped provider paths tests pass. Locale propagation/accessibility final acceptance remains incomplete. |
| Free provider verification, live grounded questions/reviews/generation and failures | Root | Configured stealth/space-bunny-alpha catalog reports0 prompt/completion withtools/response_format; authenticated question and later dated-balance questionHTTP200. Capability settings/livegeneration still pending |
| Insights relevance/dismiss/mute/dedup/evidence freshness | schema |046 bounded deterministic nine-type engine/preference/dismissal/evidence-key dedup slice in progress; no acceptance claim. |
| Weekly/monthly durable scheduled summaries, visible status/cancellation | schema | `65fe35c`: real authenticated local scheduler dispatch plus actual free-model saved review/dedup/cancel/disable PASS. Production automatic Vercel trigger/secret verification blocked by dashboard login and absent local credentials. |
| Broader tools/state/AI and code edits/version restore/pinning/exports | imports | `bc44dfc` broader manifests/SDK/render/code/version/export; actual browser exports+PDF render PASS. Actual free-provider generation/edit/restore/PNG now PASS, cancellation PASS; version defaults regression fixed and browserPASS15.2s. Pending coherent047 consumers commit. |
| Browser worker limits/missing data/invalid/runaway/oversized/stale/denied execution | Root | Pending |
| Two disposable users: pages/APIs/RPC/files/artifacts/workflows isolation | schema | `4460f57` real two-user browser pages/APIs/RPC/file access/workflow cancellation isolation PASS32s; exact synthetic users/storage cleanup verified. Current schema-wide foreign table/RPC fixtures pass. |
| Empty/error/keyboard/mobile/dark accessibility journeys | Root | Pending |
| Final unit/lint/build/full authenticated E2E; deployed commit/migrations/logs | Root | Pending |

## Coordination and decisions

- Git is coordinated centrally; agents report diffs and executed checks, root reviews before commits.
- Imports owns CSV/parser/import workflow and mapping UI/API; finance owns calculations and artifact snapshot/SDK; schema owns Drizzle definitions. Root owns model/balance work and acceptance. No simultaneous builds/dev servers against `.next`.
- Preserve original posting currencies; excluded pending/transfers cannot invalidate otherwise valid same-currency cashflow. Unsupported statement states and unreviewed account routing must fail visibly.
- Source labels alone do not prove internal transfers or fee inclusion; avoid silently suppressing movements or adding duplicate fees.
- Use existing Supabase/Vercel projects. Credentials and statement contents remain local; authenticate disposable users through existing admin API only.

## Commits / verification / blockers

-55ff3dc progress ledger;17ec106 budget currency/calendar;cfba8d4 tool exactness;53b9687 schema parity;6c31a7e import routing/status;534c12b chat safety.
- Latest integrated unit checkpoint:36 files/156 tests passed; lint passed; subsequent focused dashboard/manual-date/provider checks pass. Initial build passed; final build and full authenticated suite remain required.
- Private first imports ran using pre022 workflow revisions; some rows appended after classification backfill may lack reasons. Final classification acceptance requires a fresh disposable workspace after022.
- Real larger workflow persisted progress only at250; source rows continued increasing. First acceptance poll window expired while genuinely running, then subsequent verification completed.022 now recounts every25 rows and has replay regression.
- Both original supplied files remain untracked/uncommitted; temporary auth/acceptance evidence remains in ignored test-results/e2e auth files.
- No confirmed external blocker yet. Missing auth state is setup work, not a passing gated test.
- Next: commit reviewed balance/classification/planning slices; fresh authenticated private acceptance; final integrated gates. Active owners:finance Money manual/bulk/tags/events024;schema settings/scopes025;root usage026;imports timestamp/chronology027.
- Essential remaining product scope is explicitly incomplete: richer Home customization, Money splits/wealth, planning goals/scenario history/rollover, settings rollout/schedules/insights, broader tools/exports, complete AI orchestration and all live journeys. No completion claim.

## Oct 2 integration checkpoint

- Commits:5a57c92 planning audit/undo;356ce50 manual/bulk Money edits;a624159 preferences/free-model checks;a4cde02 scoped chat and reported usage.
- Applied024?027 atomically with exact history hashes;029 dashboard layout applied after fresh/upgraded27 migrations and10 SQL regressions passed. Central schema aligned;028 splits and030 summaries in progress.
- Home persisted built-in/saved-tool ordering/visibility, upcoming confirmed obligations, exact goal reservations and evidence-based warnings implemented; focused tests/typecheck pass before concurrent new slices. Agent review caught inherited widget names, payment ordering and historical west-of-UTC date; fixed with regressions/shared calendar boundary. Browser acceptance pending.
- Money authenticated journey ran and failed at exact wrapped select label locator; correcting assertion to accessible combobox role, then rerun. This is not a pass.
- Playwright clears its output folder, removing temporary evidence/helpers. Restored helpers and preserved authenticated user IDs/sessions in locally ignored `.qa/`; identified exactly2 disposable candidates for scoped cleanup. Private fixtures intact. New private timestamp/classification acceptance now running.
- Provider prices now validated as exact zero decimal strings (positive underflow cannot qualify as free); focused red-green test passes. Settings atomic save follow-up031 required.
- Scheduler daily polling supports Vercel Hobby precision with period deduplication; automatic deployment execution remains unverified. No Vercel CLI/token/project link discovered yet; investigate available browser/deployment integration before treating as external blocker.

## Verified checkpoint: goals, wealth, private imports

- `382a650`: reviewed classification/timestamp/shared balance consumers. Fresh private acceptance independently verified 426 rows routed to two accounts and 169 to one; exact totals, source preservation, posting timestamps, calendar dates, fee evidence, review reasons and byte-identical repeats pass. Downstream Home/Money/Plan/trusted-tool checks pass. Both actual full-import undos pass: all 595 immutable sources remain marked undone, private ledger rows removed, unrelated manual records/goals preserved. Evidence is locally ignored `.qa/private-acceptance.json` and `.qa/private-consumer-acceptance.json`; no private filenames/totals published.
- `b75d113`: persisted Home visibility/order/tool shortcuts, verified dated metrics/obligations and warnings. Actual authenticated dashboard hide/reorder/reload/restore passes (6.9s).
- `65fe35c`: durable weekly/monthly in-app summaries, atomic preferences and immediate cancellation. SQL/prefs workflow regressions pass; local real cron authentication401 and authorized200 verified. Enabled run/dedup/cancel acceptance remains assigned to schema. Vercel administration redirects to login, with no configured local token/project link: production secret configuration and actual automatic execution remain incomplete pending access; a missing-access question is pending.
- `545b906`: dated recorded goal savings, priority/status/contribution/completion plans and versioned cash reservations/history/undo. Exact arithmetic tests and deployed authenticated SQL guard cases pass (current cash, pending holds, currency, liquidity, stale versions, request identity, tombstones and reverse undo). Actual authenticated goal-plan and reservation browser journeys pass together (2 tests,15s), including reload and undo. Future saved dates rejected by039 trigger even on direct insert. Reservations remain distinct from actual savings and future contributions.
- Reviewed/applied033 wealth,034 reservations,037 goal plans,039 evidence dates and040 currency precision. Migration hashes verified; fresh/upgraded schemas, views and triggers match and19 SQL regressions pass. Accounting precision freezes official SIX/ISO metadata rather than Intl display rounding; all existing inspected money records are EUR and unaffected, no amounts rescaled.
- Wealth agent actual browser journeys pass for fractional holdings/cost basis/gain, dated asset values, debt interest/final payoff and remove/undo; model fixtures prove debt payments reduce liquid cash once, including associated pending holds. Independent review finding on premature assumption exclusion is being addressed before acceptance/commit.
- Broader custom tool032 actual authenticated browser journey and PNG signature checks pass. Sandbox limits unchanged. Real provider generation currently fails with an injected SSE JSON error; investigating free-model structured generation/fallback. No generation pass claimed.
- Current active owners: root038 editable forecast buffers/cases/explicit additional daily spending, then budget rollover/scenario audit/insights; finance wealth closure then041 cross-currency/partial-multiple links and recurring correction propagation; schema042 account/view history/archive, two-session isolation, enabled scheduler acceptance; imports043 richer review evidence/atomic cancellation plus live generated-tool acceptance and bounded chat investigation.
- Final integrated full test/lint/build/authenticated E2E, push/PR/deployment, keyboard/mobile/dark QA and test-data cleanup remain incomplete. No completion claim; preserve user orchestrator edits and private fixtures, stage exact paths only.

## Current verified checkpoint

- `8cf33a8` fixes real expired-session server rendering at the shared client/proxy. Unit guards preserve genuine cookie failures; actual expired browser session rotates to an unexpired persistent cookie and Settings/API continue authenticated.
- `4460f57`, `5fedda6`, `a4be2ab`, `a6a3d72` are reviewed local coherent commits. Actual scenario fixture asserts independently known EUR1000 cash, zero uncertainty/buffer, hypothetical -200/-300 comparisons, remove/undo, unchanged canonical cash and zero actual ledger/reservations. Disposable scenario fixtures cleaned.
- Applied041 hash `62100c6c7f261caf37a6245c336d1346a5be59de8b869643d8abb81e4132abaa`;049 hash `5145b846b6ea74d40c219d33eb3e7a754af21fdb5c1463baa7649b84e708c7ce`. Applied migrations are immutable; central schema owner aligns new tables/RPC isolation.
- Remaining independent scope:046 insights, broad AI action impact previews, final permissions/artifact failure/worker stale tests, locale/accessibility, comprehensive imports retry/resume/cancel, integrated gates and cleanup. Final push/PR/deployed acceptance remain incomplete. Vercel production access question is pending; continue all independent work.
