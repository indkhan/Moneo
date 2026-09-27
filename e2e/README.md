# Moneo e2e (prompt.md §46)

## What runs without an authenticated session

- `e2e/core-journey.smoke.spec.ts` — boots the app, checks the home state
  appropriate to the current `.env`, `/api/health`, the login OTP form, and
  empty import history. It makes no OpenRouter calls.
- `e2e/import-journey.mocked.spec.ts` — the most useful deterministic test:
  full import UX (`Upload → AI mapping preview → Correct → Preview
  correction → Continue → history → Cancel`) against `page.route` mocks
  shaped exactly like the real `/api/imports*` responses, with synthetic
  `AUGUST_CSV` from `e2e/fixtures.ts`. Fails on any `openrouter.ai` request.

## Enabling the partial live-backend journey

`e2e/core-journey.gated.spec.ts` exercises login state, import submission,
transaction visibility, Home, goal creation, and re-import against Supabase.
It does not yet verify corrections, scenario changes, artifact pinning, or
refreshed financial values. It **skips** unless all of these exist
(a skip is reported as skipped, never as a pass):

1. Applied `supabase/migrations/*.sql` in filename order, plus `.env` with `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (see `.env.example`).
2. A Playwright `storageState` file: sign in once via the running app
   (`/login` magic link), then save the browser context:
   `E2E_STORAGE_STATE=e2e/.auth.json` (or place the file at
   `e2e/.auth.json`, which is git-ignored via `.auth.json` pattern — do not
   commit it).
3. Run: `npx playwright test --reporter=list`.

Even when enabled, the spec makes **zero live OpenRouter calls**: the
AI-proposing inspect, `/api/chat`, `/api/artifacts/generate` (suggest step),
and `/api/analysis` are fulfilled with deterministic canned payloads, while
explicit-mapping confirms, corrections, goals, scenarios, and Home metrics
hit the real backend. Any request to `*.openrouter.ai` aborts and fails.

## Coverage / gaps

Covered deterministically: import UX core (§4–§5), empty-state Home/login/
health, no-quota guarantee.
Gaps requiring the §2 setup: real auth, Postgres persistence, overlapping-
import dedup against live data, workflow resume/cancel, RLS isolation,
artifact runtime with live data, Deep Analysis synthesis quality.
Finance math (§16–§17), CSV/XLSX parsing, and artifact sandbox boundaries
are covered by Vitest unit tests, not duplicated here.
