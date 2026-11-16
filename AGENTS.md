# AGENTS.md

Moneo is an open-source personal-finance app you run on your own computer. One owner imports statements or syncs a bank, tracks accounts and wealth, plans spending, and asks about their money in chat, artifacts and voice calls.

Moneo ships two ways from this one codebase: the desktop app (`desktop/`, Electron, what most owners install) and the source installation (`npm run setup` + Docker). Every change must work in both.

Stack: Next.js 16 + React 19 + TypeScript. The backend is Postgres plus the open-source Supabase Auth, PostgREST and Storage services: in Docker for the source installation (`docker-compose.yml`), as bundled native processes in the desktop app (`desktop/src/backend/`). Drizzle schema, Workflow (local world) for durable jobs, Vitest and Playwright, and the Vercel AI SDK, paid by the owner's ChatGPT plan or an API key.

These are defaults. The developer's instructions override them; if a rule conflicts with the task, say so and ask.

## Non-negotiables

- **Local-first.** Everything listens on `127.0.0.1`; optional phone access is Tailscale forwarding to it (`lib/phone-access.ts`). Data leaves the machine only for services the owner set up (AI provider, Enable Banking, Scalable). New features must work fully offline from the cloud except those calls.
- **One owner, no accounts.** The proxy signs the owner in automatically; there is no sign-up or sign-in screen. Private access from the owner's own Tailscale devices needs no login; anything public must add one first.
- **Financial truth comes from code and data, never from AI guesses.** Money is integer minor units (`bigint`) with an explicit currency. The AI explains and proposes; every write it suggests is a card the owner accepts.
- **AI organization labels are the one exception to cards.** The organizer applies high- and medium-confidence category and merchant labels itself, marked as AI (`organized_by = 'ai'`), listed with every other AI decision and undoable; they never become owner rules or owner corrections. Every other AI write is a card.
- **History is kept.** Preserve source records, corrections, history and undo when changing financial data flows.
- **Open source.** No secrets, private statements or personal data in the repo (`npm run check:privacy` runs before tests and lint).

## How to work

1. **Think before coding.** State your assumptions. If a request has more than one reading, name them and ask instead of picking silently. If a simpler approach exists, say so.
2. **Simplicity first.** Write the least code that solves the problem: no speculative features, options or single-use abstractions. Prefer existing utilities and dependencies, and Zod for validating user and external input. Would a senior engineer call it overcomplicated? Then simplify.
3. **Surgical changes.** Touch only what the task needs and match the nearby style. Remove what your own change made unused; mention unrelated dead code instead of deleting it.
4. **Never write a comment.** Put the meaning in a name, a type, a test or a lint rule; if a comment would defend a workaround, fix the cause instead. `npm run lint` rejects comments (`moneo/no-comments` in `eslint.config.mjs`) except tool directives such as `eslint-disable-next-line <rule> -- reason`.
5. **Corrections become checks.** When a review correction could recur, enforce it with a lint rule, a type or a test whose error message says what to do instead. Add a line here only when it needs human judgment.
6. **Fix the class, not the case.** Trace a failure to the first place the system went wrong and fix it there, so every similar case is fixed with it. A guard, a retry, a swallowed error or a special case at the place it showed up hides the fault. When the assistant in the app cannot do something, give it the tool, data or scope it lacks; never add a sentence to its system prompt (`lib/ai/provider.ts`, `lib/ai/voice-*`) that names one request, keyword or example.
7. **Goal-driven.** Turn the task into checks you can run, then loop until they pass. A bug fix starts by reproducing the failure; see Tests for when that becomes a kept test. Purely visual changes get a before/after screenshot instead.

## Safety

- Never run tests or experiments against the owner's backend (`.env`, Docker project `moneo`, app on port 3000). Tests use the separate test backend below, as its QA user or disposable users they create and remove.
- Never delete the `moneo` Docker volumes (`docker compose down -v`) or drop its database: that is the owner's financial history. The test backend is disposable: `docker compose -p moneo-qa down -v` then `npm run setup -- --qa` starts it fresh.
- Never change `JWT_SECRET`, `POSTGRES_PASSWORD` or `BANK_TOKEN_ENCRYPTION_KEY` in an existing `.env`; keys, sessions and stored bank and ChatGPT tokens stop working.
- Never commit `.env*` (except `.env.example`), `.data/`, `e2e/.auth.json` or `.qa/`.
- Only kill processes you started, or ones you verified by port and working directory. Never kill by name.
- Real AI, bank and Scalable calls cost money or count against limits (PSD2 allows about 4 background bank fetches a day). Mock them in tests unless the task is to check the real service.

## Hit every surface

Before calling a feature done, check where else it shows up:

- Pages and their mobile layout, light and dark.
- Chat tools and the system prompt in `lib/ai/provider.ts`, artifacts, and the voice call (`lib/ai/voice-*`).
- Home widgets and the command palette.
- Background jobs (`lib/scheduler.ts`, `workflows/`) and imports from files, banks and Scalable.
- The desktop app: see Desktop app below.
- The reverse path: undo, reset all data, reconnect, disconnect.
- Docs: `README.md` for anything the owner sets up or runs, the landing page in `docs/` when a headline feature or install step changes, `.env.example` for new variables. Deferred work goes in GitHub issues.

## Commands

Use npm (`package-lock.json` is authoritative).

- Install: `npm ci`
- Backend: `npm run setup` (writes `.env` secrets, starts Docker, applies migrations, creates the owner; safe to rerun)
- Dev: `npm run dev` (http://localhost:3000)
- Unit: `npm test` · Lint: `npm run lint` · Build: `npm run build` · Bundle budget: `npm run check:bundle` (after a build)
- Database: `npm run test:db` (needs the backend from `npm run setup`)
- E2E: `npm run test:e2e` (see `e2e/README.md`)
- Desktop: `node scripts/desktop/fetch-backend.mjs --platform <win-x64|mac-arm64|mac-x64|linux-x64>` once, then `npm run desktop:build`, `npm run desktop:dev`, `npm run desktop:dist` and `npm run desktop:smoke` (drives the packaged app)
- Desktop release: push a `v*` tag matching `desktop/package.json`, then publish the drafted release (`desktop/README.md` → Releasing). Never tag or publish unasked.

## Test backend

Everything that needs a database or a running app is tested against `moneo-qa`, never the owner's setup:

- **Backend:** Docker project `moneo-qa` (ports 54521/54522), secrets in the git-ignored `.env.qa` (one shared copy in `~/.moneo/qa.env`, so every worktree uses the same stack). Create, upgrade or copy it into a new worktree with `npm run setup -- --qa`; then `npm run qa:auth` creates the QA user and saves `e2e/.auth.json`.
- **App:** `npm run qa:server` runs this checkout on http://localhost:3100 against `.env.qa`, building into `.next-qa`, with bank access off and a placeholder AI key that every provider rejects, so nothing costs money. `npm run test:e2e` starts it on its own and refuses to run against any server that would sign tests in as the owner.
- **Screenshots:** `npm run qa:shots -- <label> home money/transactions` saves each page in light, dark and mobile to `.qa/shots/<label>/` and fails on a console error or a failed request (skill `verify-ui`).
- **Reset:** `npm run qa:reset` empties the QA workspace. Each spec should still set up the state it needs rather than rely on what earlier runs left behind.
- `npm run test:db` and the `supabase/tests/*.mjs` scripts read `.env.qa` only.
- A nightly run (`npm run qa:nightly`, see `e2e/README.md`) runs every spec twice and keeps the issue "Nightly browser suite is failing" up to date; fix what it lists before adding new specs.

## Desktop app

The Electron app (`desktop/README.md`, `desktop/src/backend/README.md`) runs the same Next.js server as a standalone build next to its own Postgres, GoTrue, PostgREST and Storage processes. There is no Docker, Node.js, terminal or `.env` on the owner's machine, so:

- **Settings the owner needs go in the app**, not in `.env`. `desktop:build` unsets every `NEXT_PUBLIC_*` and fails if a local address is baked in; desktop-only behaviour reads `MONEO_DESKTOP_*` at runtime.
- **Migrations run on the owner's existing database** at the next start, after an automatic `pre-upgrade` backup (`desktop/src/backend/migrations.ts`). They must work without the extensions the bundle lacks: supautils, pg_graphql, pg_net, pg_cron, pgsodium/vault, pg_stat_statements, realtime, and uuid-ossp on Windows.
- **The app lives on `http://localhost:47300`** (or the port saved in `shell.json`), not 3000. Get addresses from the request or from `appUrl()`, `loopbackUrl()` and `appPort()` in `lib/env.ts`; lint rejects a hard-coded 3000.
- **Sign-ins open in the system browser** and return through the loopback callbacks; the result reaches the window through `lib/desktop-bridge.ts` and `desktop/src/bridge.ts`. The window opens only Moneo's own pages and allows only the microphone and copying.
- **Files the server reads at runtime** by a dynamic path need `/*turbopackIgnore: true*/`, or the standalone build traces source files and `desktop:build` fails.
- **A new backend service, native module or data folder** must be added to `fetch-backend.mjs`, the start order, backup and restore, and the packaged files in `electron-builder.config.cjs`.
- **Keep the security fuses** (RunAsNode, `NODE_OPTIONS` and `--inspect` off; asar integrity on); `desktop:smoke` reads them back.
- Never test against the owner's installed app or its user-data folder; set `MONEO_DESKTOP_HOME` to a scratch folder.

The Desktop workflow builds and smoke-tests every platform on pull requests that touch `desktop/`, `scripts/desktop/`, `next.config.ts`, `package*.json` or `supabase/migrations/`.

## Project map

- `app/` — App Router pages, route handlers, server actions
- `components/` — shared UI
- `lib/finance/` — deterministic financial logic
- `lib/ai/` — models, chat tools, ChatGPT sign-in (`chatgpt.ts`), voice
- `lib/bank/`, `lib/scalable/` — Enable Banking and Scalable Capital
- `lib/schema.ts` + `supabase/migrations/` — database schema
- `workflows/` — durable background jobs; `lib/scheduler.ts` runs the daily ones
- `docker-compose.yml`, `docker/`, `scripts/setup.mjs` — the self-hosted backend
- `e2e/` — Playwright flows; `supabase/tests/` — SQL regressions
- `desktop/` — the Electron app (`src/` main process, `src/backend/` native backend, `setup/` status window, `bootstrap/` first-run SQL); `scripts/desktop/` builds, packages and smoke-tests it; `.github/workflows/desktop.yml` runs that and drafts releases
- `docs/` — the GitHub Pages landing page (https://indkhan.github.io/Moneo/); its download button reads the latest published release

Imports go one way: `app/` → `components/` → `lib/` and `workflows/`. `lib/finance/` never imports `lib/ai/`, and Electron stays in `desktop/src`. Lint enforces all of it (`moneo/import-boundaries`); code that two layers need lives in the lower one.

## Rules and what enforces them

When a correction could recur, enforce it (skill `review-to-rule`) and add a row here. A rule with nothing in the right-hand column is only a hope.

| Rule | Enforced by |
| --- | --- |
| No comments, except exact tool directives | `moneo/no-comments` (lint, autofix) |
| `app/` → `components/` → `lib/`, `workflows/`; `lib/finance` never imports `lib/ai`; Electron only in `desktop/`; no app code in `desktop/src` | `moneo/import-boundaries` (lint) |
| The modules every page loads (`lib/auth`, `lib/settings`, `lib/safe-action`, `lib/env`) never import `lib/ai` | `moneo/import-boundaries` (lint) |
| Dates use the owner's time zone from Settings (detected from their device, saved on first load); no function assumes one | required `timeZone` parameters (compiler); `no-restricted-syntax` (lint) |
| No hard-coded port 3000 or app address outside `lib/env.ts` | `no-restricted-syntax` (lint) |
| Tests never wait on a real timer, skip from inside a test, read migration text, or touch port 3000 | `no-restricted-syntax` (lint) |
| One way to make a database client: `serviceDb()` for the service role, `createClient()` in `lib/supabase-server.ts` for the owner | `no-restricted-imports` (lint) |
| Every scheduled route checks the cron secret, through `cronRoute()` | `lib/cron.test.ts` walks every route; `no-restricted-properties` (lint) |
| A workflow never ignores a failure without naming what handles it | `no-restricted-syntax` (lint, `workflows/`) |
| No `eslint-disable` that suppresses nothing | `reportUnusedDisableDirectives` (lint) |
| Every code path returns; overrides are marked; no switch fall-through | `tsconfig.json` |
| A stored preference this version cannot read never blocks sign-in | `lib/settings.test.ts` |
| The assistant's system prompt does not grow by special cases | budget in `lib/ai/provider.test.ts` |
| `lib/schema.ts` matches the migrated database; app and database agree on currency minor units; SQL conflicts are never raised as `40001` | `lib/schema.live.test.ts` (`npm run test:db`, CI job `database`) |
| No secrets, statements or personal data in the repo | `npm run check:privacy` (runs before test and lint) |
| A page's JavaScript stays within its size budget | `npm run check:bundle` |
| A test file runs in 10 seconds or less | CI, "Slowest test files" |

## Sign-in callbacks and addresses

Each outside service sends the browser back to a different address. Keep these in mind before changing ports, hosts or remote access:

- **Sign in with ChatGPT** (`lib/ai/chatgpt.ts`): OpenAI only accepts the loopback `http://127.0.0.1:<PORT>/api/ai/chatgpt/callback`, so sign-in happens on the computer running Moneo. Tokens are stored there, so chat works from any device afterwards.
- **Enable Banking** (`lib/bank/return-listener.ts`): production apps need an `https://` redirect registered in the Enable Banking app. Moneo uses `https://localhost:3443/api/bank/callback` (a local listener with a cert from `npm run setup`), which forwards to `NEXT_PUBLIC_APP_URL`.
- **Scalable Capital** (`lib/scalable/server.ts`): dynamic client registration with `NEXT_PUBLIC_APP_URL/api/scalable/callback`. `localhost` registers freely; other hosts need Scalable's allowlist (it rejects `*.ts.net`).
- **Supabase** (`NEXT_PUBLIC_SUPABASE_URL`, `127.0.0.1:54321`): only the server may call it; never send the browser there, or it breaks on other devices.
- **Desktop app**: the same callbacks on the app's own port (47300 by default) instead of 3000.
- **Phone and tablet** (`*.ts.net` through Tailscale Serve): the laptop's addresses above never change. The three logins refuse to start from a remote device (`lib/remote-device.ts`) and say to use the computer; everything else, including sync, works from there.
- **Voice** needs a secure context (https or localhost) for the microphone.

## Database changes

Add a new ordered migration in `supabase/migrations/` and keep `lib/schema.ts` aligned. Never rewrite an applied migration. `npm run setup` applies pending ones and records them in `supabase_migrations.schema_migrations`. For other Supabase CLI commands use `npx supabase ... --db-url "$SUPABASE_DB_URL"` (from `.env`).

## Tests

A test earns its place by failing when real behaviour breaks. Before writing one, name the bug it would catch.

- **Write tests for** money math, imports and undo, auth, RLS and AI scopes, concurrency, and bugs that actually happened (name the PR or issue).
- **Don't write tests that** assert UI copy or labels, grep source or migration files, mirror the implementation, or need more than about three `vi.mock`s to run. Test the `lib/` function instead.
- Check each test against two imagined edits. Break the behaviour (a wrong value, a skipped or doubled effect): the test must fail. Restructure the internals without changing any result: the test must still pass. Rewrite or delete a test that misses either. Take the expected value from the requirement, never from a run of the code, and never assert on data the test built itself.
- One test per behaviour. Don't add a test per requirement or per audit finding; if an existing test covers the failure, extend it.
- `npm test` must pass with no `.env`, no Docker and no network. Anything that needs the database is a `*.live.test.ts`.
- Use fake timers or controlled promises, never real waits. Mock AI, bank and Scalable; real calls are opt-in only.
- Browser specs are for whole user journeys, not single links or labels. Add a spec only when no existing journey can take the check.
- When you remove a feature, remove its tests. Never delete or skip a failing test just to get green: fix the cause, or ask.
- If a pointless test lands, find out why the agent wrote it and fix the guidance here.

Run the smallest relevant test while iterating. Before finishing, run `npm test`, `npm run lint` and `npm run typecheck`; add `npm run build` for app, config or build changes, and Playwright for changed user flows. CI runs the same checks on every pull request, and `npm run test:db` against a fresh test backend.

## Commits and pull requests

- Break the work into steps and commit each one; a big task is several commits.
- Write commit messages in plain language: what changed and why.
- Deferred work gets their issue created on github.
- Stacked PRs: before merging a PR that another open PR is based on, change the dependent PR's base to `main`; deleting the merged branch otherwise closes it.
- Long agent prompts and plans don't get committed; if guidance must persist, put the rule in AGENTS.md.
- suggest edits in agents.md if there was something that is changed or needs to be there in agents.md but only suggest when it is actually needed dont suggest just for suggesting.(only for prs)

## Context

Read only what the task needs: `.env.example` for environment names, `e2e/README.md` for browser tests, `supabase/tests/README.md` for SQL checks.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
