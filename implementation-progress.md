# Implementation progress

Starting revision: `97f267b`; baseline audit: `4d90ee4`. Existing orchestrator edit and two private CSVs are preserved and excluded from staging. Bank connections remain deferred.

## Acceptance ledger

Items are incomplete until integrated checks and live evidence establish them. Existing behavior is not automatically accepted.

| Requirement / acceptance | Owner / dependency | State / evidence |
| --- | --- | --- |
| Reproduce unit/lint/build/browser baseline and gated drift | Root | Baseline reproduced:98 tests/18 files, lint/build pass; anonymous E2E8 pass/1 skip; authenticated heading failure reproduced then repaired journey1 pass. Deployed anonymous login redirect verified; collaborative snapshot failed twice |
| Explicit import product/account/currency routing, normalized statuses, private source totals, fees/type review | imports agent; schema only if needed | Routing/status implemented6c31a7e. Private426 rows routed2 accounts and169 rows1 account; original rows/exact independently calculated totals/repeat IDs/undo previews verified live. Classification/timestamp acceptance still incomplete |
| Import repeat/overlap, retry/resume/cancel/progress, preservation and undo | Root after routing | Pending authenticated journeys |
| Cashflow exclusions, per-goal currencies, complete tool daily coverage | finance agent | Implementedcfba8d4;13 targeted tests; reviewed by schema agent. Pending classification partial labels integrated separately |
| Reconciled dated balances and shared tie/boundary rules; stale/missing labels | imports/root | Implemented conservative resolver and consumers;14 targeted tests plus Berlin manual-date regression. Source timestamp precision remains pending |
| Schema parity, fresh/upgraded migrations, RLS and workspace relationships | schema agent | 53b9687 aligned30 baseline tables; deployed/fresh rollback schemas match. Applied020/021/022/023 atomically with hashes; real SQL regressions pass. Fresh auth uses surrogate and storage setup excluded |
| Transfer/refund cross-currency, partial/multiple linking, fees, correction propagation, undo | Root; migration owner assigned before edits | Pending |
| Home metrics, dates/provenance, persisted widgets/order and first review choices | Root | Pending |
| Money manual/accounts/search/saved views/bulk/tags/splits/events/history | Root | Pending |
| Confirmed recurring effective dates/history; evidence corrections | Root | Pending |
| Investments quantities/prices/cost basis, assets dated values, debt schedules and liquidity separation | Root | Pending |
| Goals priority/contributions/affordability; no duplicate reservations | Root | Pending |
| Calendar budgets/rollover and plans; 12-month scenarios/cases/editable buffers | Root |17ec106 fixes refund currency/Berlin month; rollover/buffers and full scenario evidence pending |
| Financial Model sources/assumptions/history; Berlin dates/DST/leap/month-end | Root | Pending |
| Persistent contextual chat/reviews/tool library/activity; effective cancellation | Root |534c12b adds persisted chat states, atomic cancellation/write/reply guards;2 browser cancellation tests; actual concurrent duplicate/cancel SQL check passes. Review/tool generation cancellation still incomplete |
| Validated targeted AI writes, preview broad/destructive actions, idempotency/concurrency | Root | Exact UUID/quoted-category commands validated independently from model; ambiguous prose cannot grant model targets; DB+parser tests pass. Broader product impact previews pending |
| Settings currency/timezone/theme/models/scopes/usage/insights/summaries | Root | Pending |
| Free provider verification, live grounded questions/reviews/generation and failures | Root | Configured stealth/space-bunny-alpha catalog reports0 prompt/completion withtools/response_format; authenticated question and later dated-balance questionHTTP200. Capability settings/livegeneration still pending |
| Insights relevance/dismiss/mute/dedup/evidence freshness | Root | Pending |
| Weekly/monthly durable scheduled summaries, visible status/cancellation | Root | Pending |
| Broader tools/state/AI and code edits/version restore/pinning/exports | Root | Pending |
| Browser worker limits/missing data/invalid/runaway/oversized/stale/denied execution | Root | Pending |
| Two disposable users: pages/APIs/RPC/files/artifacts/workflows isolation | schema/root | Actual authenticated-role SQL denies foreign reads for32 tables and23 mutationRPCs. Actual RESTbigint casts verified beyond2^53. Pages/files/workflow two-session acceptance pending |
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
