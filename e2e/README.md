# Browser tests

Playwright tests run against the separate test backend (Docker project `moneo-qa`, `.env.qa`) and this checkout's app on http://localhost:3100. The config starts the app with `npm run qa:server` (or a production build with `E2E_PRODUCTION_BUILD=1`) unless it is already running.

## Setup

1. Create the test backend once (and after pulling new migrations): `npm run setup -- --qa`.
2. Create the QA user and save its session: `npm run qa:auth`. Its login is stored in `.env.qa` as `E2E_USER_EMAIL`/`E2E_USER_PASSWORD`, and its session in `e2e/.auth.json` (or set `E2E_STORAGE_STATE`).
3. Before a full run, empty its workspace: `npm run qa:reset`.

The whole test backend is disposable: `docker compose -p moneo-qa down -v` and step 1 start it fresh. The owner's `moneo` project is never touched.

Tests never use the owner's workspace. Every spec runs with the saved QA session and an `x-moneo-test` header; with that header the app refuses a request that has no valid session instead of signing the owner in (`proxy.ts`). Before any spec runs, `e2e/global-setup.ts` checks that the server under test does this, so an older or foreign server on the port stops the run.

## Running

```sh
npm run test:e2e -- --workers=1
```

Use one worker: several specs change the same QA workspace and its preferences. The QA server builds into `.next-qa`, so it can run beside `npm run dev`.

## Kinds of specs

- `*.smoke.spec.ts` and `*.mocked.spec.ts` stub or skip the backend. Against a configured backend they still need the QA session, like every spec.
- `*.gated.spec.ts` need the backend. Most use the QA session; others create disposable users with the service key, sign them in by session cookie, and remove them in `finally`. If interrupted, their IDs are left in ignored `.qa/` files for cleanup.
- `*.provider.spec.ts` call the real AI model, so they cost money. They run only with `E2E_REAL_AI=1`; `npm run test:e2e` leaves them out.
- `review-runtime.config.ts` and `review-investigation.config.ts` run the real Workflow engine against local synthetic database and model servers (ports 3040/3041), including a server restart mid-review: `npx playwright test --config e2e/review-runtime.config.ts`.

A skipped spec is not a pass: it means a prerequisite (backend, QA session, service key) is missing.

## Scalable

`scalable-trading.provider.spec.ts` drives chat against a local stand-in for Scalable's MCP server (`e2e/mocks/scalable-mcp.mjs`, made-up data) with the real AI model. Start `npm run qa:server` with `SCALABLE_MCP_ORIGIN=http://127.0.0.1:3043` (and the AI key in `.env.qa`) and run the spec with the same variable and `E2E_REAL_AI=1`; the spec starts the stand-in, adds a Scalable connection to the QA workspace and removes it afterwards. It checks that an order is previewed on a card and sent only when the card is tapped, once, and that read-only access is told it can't trade.
