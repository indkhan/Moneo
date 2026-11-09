# Database checks

These scripts test the SQL functions, row-level security and concurrency of the self-hosted database. They read `SUPABASE_DB_URL` and the Supabase keys from `.env` (written by `npm run setup`).

## Migrations and regressions

`npm run test:db` runs the migration replay below and then every opt-in `*.live.test.ts`, one file at a time.

```sh
node supabase/tests/migrations.mjs
```

Replays every migration into a temporary schema, compares it with the current schema (columns, constraints, indexes, RLS, policies, views, triggers, functions), and runs the `.sql` regression fixtures on both. Everything runs in rollback-only transactions; migration history stays unchanged and the temporary schema is removed.

`workspace-isolation.sql` seeds two synthetic users with records in every application table and checks, as the `authenticated` role, that neither can see or change the other's data. Keep its fixtures and RPC cases in step when adding tables or mutations.

Single regressions run with their `run-*.mjs` script, for example `node supabase/tests/run-goal-reservations.mjs`. `run-sql.mjs` runs the import-review fixture.

## Concurrency

`*-concurrency.mjs` scripts (chat, imports, reviews, recurring occurrences, reservations) open separate authenticated and service connections to check locks, cancellation and duplicate claims. They create synthetic users or a disposable schema, remove them by exact ID, and leave a recovery note in ignored `.qa/` files if interrupted.

## Live checks

- `precision.mjs` reads Money and budget pages through PostgREST with amounts beyond JavaScript's safe integer range.
- `summary-live.mjs` (with the app running) checks scheduled summaries end to end: dispatch, deduplication per period, cancellation and disabling.
- Opt-in unit tests compare SQL with application logic, for example `RUN_RESERVATION_DB_TESTS=1 npm test -- lib/finance/reservation-balance.live.test.ts` (PowerShell: `$env:RUN_RESERVATION_DB_TESTS='1'` first).

None of these touch the owner's workspace. Migrations themselves are applied by `npm run setup`.
