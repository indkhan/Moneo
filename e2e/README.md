# Moneo e2e (prompt.md §46)

## What runs without credentials (now — blank `.env`)

- `e2e/core-journey.smoke.spec.ts` — boots the app, asserts the honest
  missing-Supabase home state, `/api/health` (`supabase:false`,
  `openrouter:false`), login OTP form, and empty import history. No Supabase,
  no OpenRouter.
- `e2e/import-journey.mocked.spec.ts` — the most useful deterministic test:
  full import UX (`Upload → AI mapping preview → Correct → Preview
  correction → Continue → history → Cancel`) against `page.route` mocks
  shaped exactly like the real `/api/imports*` responses, with synthetic
  `AUGUST_CSV` from `e2e/fixtures.ts`. Fails on any `openrouter.ai` request.
- `e2e/home.spec.ts` — pre-existing missing-Supabase assertion (kept).

## §2 — Enabling the full gated journey

`e2e/core-journey.gated.spec.ts` implements the complete §46 loop
(auth → upload → confirm mapping → import → correct → Home → grounded
question → goal → scenario/forecast → Deep Analysis → artifact → pin →
re-import → coherence check). It **skips** unless all of these exist
(a skip is reported as skipped, never as a pass):

1. `.env` with `NEXT_PUBLIC_SUPABASE_URL` and
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

## Coverage / gaps (2026-09-26, blank `.env`)

Covered deterministically: import UX core (§4–§5), empty-state Home/login/
health, no-quota guarantee.
Gaps requiring the §2 env: real auth, Postgres persistence, overlapping-
import dedup against live data, workflow resume/cancel, RLS isolation,
artifact runtime with live data, Deep Analysis synthesis quality.
Finance math (§16–§17), CSV/XLSX parsing, and artifact sandbox boundaries
are covered by Vitest unit tests, not duplicated here.
