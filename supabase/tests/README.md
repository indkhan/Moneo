# Database regression checks

Run `node supabase/tests/migrations.mjs` with the existing `.env` configuration. The script verifies that `SUPABASE_DB_URL` targets `NEXT_PUBLIC_SUPABASE_URL`, then tests pending migrations against the deployed application schema and replays every migration into a temporary isolated schema. It compares columns, constraints, indexes, RLS, policies, views, triggers and application functions, and runs the synthetic `.sql` regressions on both paths.

All writes run inside rollback-only transactions. Migration history stays unchanged, and the script verifies that its temporary schema was removed. It does not apply migrations permanently. Fresh verification uses an empty `auth.users` surrogate and skips Supabase-owned storage bucket/policy setup; full Supabase platform bootstrap still requires a disposable local Supabase instance.

`workspace-isolation.sql` seeds two synthetic users and foreign records in every current application table. It switches to the actual `authenticated` database role to check row visibility and foreign-target RPC denial. Keep its fixture list and RPC cases aligned when adding tables or mutations.

Run `node supabase/tests/precision.mjs` to verify the actual Money/budget page SELECTs through PostgREST with amounts beyond JavaScript's safe integer range. This check temporarily commits a synthetic user/workspace and removes only those records in `finally`; it verifies cleanup. It requires the existing service-role key, which is never printed.

Run `node supabase/tests/chat-concurrency.mjs` after migration 023 is applied to check duplicate claims and cancellation on separate authenticated connections. It verifies cancellation waits for the execution lock and prevents later corrections/replies, then removes its synthetic user/workspace.

Run `node supabase/tests/review-concurrency.mjs` after migration 043 is applied to exercise review finish/cancel and first preference-insert races on separate real authenticated/service connections. Cancellation or scope revocation prevents analysis persistence; a committed finisher retains its historical result. Synthetic fixtures are removed by exact IDs.

Run `node supabase/tests/import-concurrency.mjs` after migration 051 is applied to check cancellation and ingestion on separate authenticated/service connections. It observes the specific waiter and holder database process locks, verifies cancellation cannot admit later row effects, retains already committed source evidence, fences old workers after resume and deduplicates simultaneous retries. Its exact large-money synthetic records are removed by ID.

Run `node supabase/tests/summary-live.mjs` with the local app running and its existing `CRON_SECRET` configured to verify actual cron dispatch, free-model review completion, period deduplication, cancellation and disabling. It uses a disposable empty workspace and targeted cleanup. This verifies the local endpoint/workflow; it does not prove that Vercel's external daily cron has been deployed.

Run `npx playwright test e2e/two-user-isolation.gated.spec.ts --reporter=list` for two real disposable authenticated users. It exercises page/API/file ownership, denied foreign review cancellation, account editing/archive/sequential undo, saved view rename/removal/filter replacement/undo, Home insight dismissal/restore, exact large relevance thresholds and type mute/unmute. It requires the configured admin/auth/database environment, sends no email, uses no saved credentials or mocked backend, and removes its fixtures. Recovery IDs are written to ignored `.qa` files only if interrupted.

`insight-preferences.sql` checks owner isolation, exact thresholds beyond JavaScript's safe integer range, dismissal deduplication, bounded lookahead and dismissal restoration. The pure insight fixtures cover all nine supported types, dated evidence changes, ambiguity suppression, half-up medians and filling the item limit after dismissed evidence is removed. Insights make no model calls.

For the targeted import review regression only, use `node supabase/tests/run-sql.mjs --candidate` before applying migration 020, or omit `--candidate` afterward. It also rolls back its synthetic fixtures and candidate function replacement.

Run `node supabase/tests/run-goal-reservations.mjs` for the reservation boundary/history fixture. For SQL/application resolver parity, run `RUN_RESERVATION_DB_TESTS=1 npm test -- lib/finance/reservation-balance.live.test.ts` (PowerShell: set `$env:RUN_RESERVATION_DB_TESTS='1'` first). This opt-in test compares six synthetic balance fixtures and rolls everything back.

Deployment is separate: `node supabase/tests/apply-migrations.mjs VERSION...` applies only explicitly listed ordered versions after review and rollback verification. It verifies the configured project, refuses skipped earlier pending files, locks migration history, compares names/content hashes, applies SQL and history atomically, and verifies hashes afterward. Do not run it as a routine test.
