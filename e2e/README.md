# Browser tests

Playwright tests run against the app on http://localhost:3000. The config starts it (`npm run dev`, or the production build with `E2E_PRODUCTION_BUILD=1`) unless a server is already running there.

## Setup

1. Start the backend: `npm run setup`.
2. Create the QA user and save its session: `node --env-file=.env scripts/e2e-auth.mjs`. Its login is stored in `.env` as `E2E_USER_EMAIL`/`E2E_USER_PASSWORD`, and its session in `e2e/.auth.json` (or set `E2E_STORAGE_STATE`).
3. Before a full run, empty its workspace: `node --env-file=.env scripts/e2e-auth.mjs --reset`. Never delete the user.

Tests never use the owner's workspace: a saved QA session takes the place of the owner's automatic sign-in.

## Running

```sh
npm run test:e2e -- --workers=1
```

Use one worker: several specs change the same QA workspace and its preferences. Stop a running server on port 3000 before `npm run build`, so the two don't write `.next` at the same time.

## Kinds of specs

- `*.smoke.spec.ts` and `*.mocked.spec.ts` need no saved session; mocked specs stub API responses to check UI contracts.
- `*.gated.spec.ts` need the backend. Most use the QA session; others create disposable users with the service key, sign them in by session cookie, and remove them in `finally`. If interrupted, their IDs are left in ignored `.qa/` files for cleanup.
- `core-journey.gated.spec.ts` calls the real AI provider, so it costs money: run it only when you mean to.
- `review-runtime.config.ts` and `review-investigation.config.ts` run the real Workflow engine against local synthetic database and model servers (ports 3040/3041), including a server restart mid-review: `npx playwright test --config e2e/review-runtime.config.ts`.

A skipped spec is not a pass: it means a prerequisite (backend, QA session, service key) is missing.

## Acceptance

`npm run acceptance:fast` runs unit tests, lint and the build. `npm run acceptance:required` then runs the SQL regressions, live database checks and the browser suite on that build with one worker. Results go to an ignored `.qa/acceptance-*` folder; logs there may contain workspace data, so keep them out of the repo.

## Scalable

`scalable-trading.gated.spec.ts` drives chat against a local stand-in for Scalable's MCP server (`e2e/mocks/scalable-mcp.mjs`, made-up data) with the real AI model. Start the app with `SCALABLE_MCP_ORIGIN=http://127.0.0.1:3043` and run the spec with the same variable; the spec starts the stand-in, adds a Scalable connection to the QA workspace and removes it afterwards. It checks that an order is previewed on a card and sent only when the card is tapped, once, and that read-only access is told it can't trade.
