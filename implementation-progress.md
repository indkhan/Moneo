# Implementation progress

Starting revision: `97f267b`; baseline audit: `4d90ee4`. Existing orchestrator edit and two private CSVs are preserved and excluded from staging. Bank connections remain deferred.

## Acceptance ledger

Items are incomplete until integrated checks and live evidence establish them. Existing behavior is not automatically accepted.

| Requirement / acceptance | Owner / dependency | State / evidence |
| --- | --- | --- |
| Reproduce unit/lint/build/browser baseline and gated drift | Root | 98 tests / 18 files and lint pass; build running; deployed anonymous page redirects to login |
| Explicit import product/account/currency routing, normalized statuses, private source totals, fees/type review | imports agent; schema only if needed | In progress; parser/workflow/UI ownership |
| Import repeat/overlap, retry/resume/cancel/progress, preservation and undo | Root after routing | Pending authenticated journeys |
| Cashflow exclusions, per-goal currencies, complete tool daily coverage | finance agent | In progress; calculations/snapshot/SDK ownership |
| Reconciled dated balances and shared tie/boundary rules; stale/missing labels | Root | Pending |
| Schema parity, fresh/upgraded migrations, RLS and workspace relationships | schema agent | In progress; schema ownership; no migration writes yet |
| Transfer/refund cross-currency, partial/multiple linking, fees, correction propagation, undo | Root; migration owner assigned before edits | Pending |
| Home metrics, dates/provenance, persisted widgets/order and first review choices | Root | Pending |
| Money manual/accounts/search/saved views/bulk/tags/splits/events/history | Root | Pending |
| Confirmed recurring effective dates/history; evidence corrections | Root | Pending |
| Investments quantities/prices/cost basis, assets dated values, debt schedules and liquidity separation | Root | Pending |
| Goals priority/contributions/affordability; no duplicate reservations | Root | Pending |
| Calendar budgets/rollover and plans; 12-month scenarios/cases/editable buffers | Root | Pending |
| Financial Model sources/assumptions/history; Berlin dates/DST/leap/month-end | Root | Pending |
| Persistent contextual chat/reviews/tool library/activity; effective cancellation | Root | Pending |
| Validated targeted AI writes, preview broad/destructive actions, idempotency/concurrency | Root | Pending |
| Settings currency/timezone/theme/models/scopes/usage/insights/summaries | Root | Pending |
| Free provider verification, live grounded questions/reviews/generation and failures | Root | Pending |
| Insights relevance/dismiss/mute/dedup/evidence freshness | Root | Pending |
| Weekly/monthly durable scheduled summaries, visible status/cancellation | Root | Pending |
| Broader tools/state/AI and code edits/version restore/pinning/exports | Root | Pending |
| Browser worker limits/missing data/invalid/runaway/oversized/stale/denied execution | Root | Pending |
| Two disposable users: pages/APIs/RPC/files/artifacts/workflows isolation | Root | Pending |
| Empty/error/keyboard/mobile/dark accessibility journeys | Root | Pending |
| Final unit/lint/build/full authenticated E2E; deployed commit/migrations/logs | Root | Pending |

## Coordination and decisions

- Git is coordinated centrally; agents report diffs and executed checks, root reviews before commits.
- Imports owns CSV/parser/import workflow and mapping UI/API; finance owns calculations and artifact snapshot/SDK; schema owns Drizzle definitions. Root owns model/balance work and acceptance. No simultaneous builds/dev servers against `.next`.
- Preserve original posting currencies; excluded pending/transfers cannot invalidate otherwise valid same-currency cashflow. Unsupported statement states and unreviewed account routing must fail visibly.
- Source labels alone do not prove internal transfers or fee inclusion; avoid silently suppressing movements or adding duplicate fees.
- Use existing Supabase/Vercel projects. Credentials and statement contents remain local; authenticate disposable users through existing admin API only.

## Commits / verification / blockers

- No implementation commits yet.
- No confirmed external blocker yet. Missing auth state is setup work, not a passing gated test.
- Next: integrate first correctness slices, independent agent review, reproduce authenticated baseline, then progress through the remaining acceptance ledger.
