# AGENTS.md

Moneo is an open-source personal-finance app you run on your own computer. One owner imports statements or syncs a bank, tracks accounts and wealth, plans spending, and asks about their money in chat, artifacts and voice calls.

Stack: Next.js 16 + React 19 + TypeScript. The backend is Postgres plus the open-source Supabase Auth, PostgREST and Storage services in Docker (`docker-compose.yml`). Drizzle schema, Workflow (local world) for durable jobs, Vitest and Playwright, and the Vercel AI SDK, paid by the owner's ChatGPT plan or an API key.

These are defaults. The developer's instructions override them; if a rule conflicts with the task, say so and ask.

## Non-negotiables

- **Local-first.** Everything listens on `127.0.0.1`; optional phone access is Tailscale forwarding to it (`lib/phone-access.ts`). Data leaves the machine only for services the owner set up (AI provider, Enable Banking, Scalable). New features must work fully offline from the cloud except those calls.
- **One owner, no accounts.** The proxy signs the owner in automatically; there is no sign-up or sign-in screen. Private access from the owner's own Tailscale devices needs no login; anything public must add one first.
- **Financial truth comes from code and data, never from AI guesses.** Money is integer minor units (`bigint`) with an explicit currency. The AI explains and proposes; every write it suggests is a card the owner accepts.
- **History is kept.** Preserve source records, corrections, history and undo when changing financial data flows.
- **Open source.** No secrets, private statements or personal data in the repo (`npm run check:privacy` runs before tests and lint).

## How to work

1. **Think before coding.** State your assumptions. If a request has more than one reading, name them and ask instead of picking silently. If a simpler approach exists, say so.
2. **Simplicity first.** Write the least code that solves the problem: no speculative features, options or single-use abstractions. Prefer existing utilities and dependencies, and Zod for validating user and external input. Would a senior engineer call it overcomplicated? Then simplify.
3. **Surgical changes.** Touch only what the task needs and match the nearby style. Remove what your own change made unused; mention unrelated dead code instead of deleting it.
4. **Goal-driven.** Turn the task into checks you can run, then loop until they pass. A bug fix starts by reproducing the failure; see Tests for when that becomes a kept test. Purely visual changes get a before/after screenshot instead.

## Safety

- Never run tests or experiments against the owner's workspace. Browser tests use the QA user (`scripts/e2e-auth.mjs`) or disposable users they create and remove.
- Never delete the Docker volumes (`docker compose down -v`) or drop the database: that is the owner's financial history.
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
- The reverse path: undo, reset all data, reconnect, disconnect.
- Docs: `README.md` for anything the owner sets up or runs, `.env.example` for new variables. Deferred work goes in GitHub issues.

## Commands

Use npm (`package-lock.json` is authoritative).

- Install: `npm ci`
- Backend: `npm run setup` (writes `.env` secrets, starts Docker, applies migrations, creates the owner; safe to rerun)
- Dev: `npm run dev` (http://localhost:3000)
- Unit: `npm test` · Lint: `npm run lint` · Build: `npm run build` · Bundle budget: `npm run check:bundle` (after a build)
- Database: `npm run test:db` (needs the backend from `npm run setup`)
- E2E: `npm run test:e2e` (see `e2e/README.md`)

## Project map

- `app/` — App Router pages, route handlers, server actions
- `lib/finance/` — deterministic financial logic
- `lib/ai/` — models, chat tools, ChatGPT sign-in (`chatgpt.ts`), voice
- `lib/bank/`, `lib/scalable/` — Enable Banking and Scalable Capital
- `lib/schema.ts` + `supabase/migrations/` — database schema
- `workflows/` — durable background jobs; `lib/scheduler.ts` runs the daily ones
- `docker-compose.yml`, `docker/`, `scripts/setup.mjs` — the self-hosted backend
- `e2e/` — Playwright flows; `supabase/tests/` — SQL regressions

## Sign-in callbacks and addresses

Each outside service sends the browser back to a different address. Keep these in mind before changing ports, hosts or remote access:

- **Sign in with ChatGPT** (`lib/ai/chatgpt.ts`): OpenAI only accepts the loopback `http://127.0.0.1:<PORT>/api/ai/chatgpt/callback`, so sign-in happens on the computer running Moneo. Tokens are stored there, so chat works from any device afterwards.
- **Enable Banking** (`lib/bank/return-listener.ts`): production apps need an `https://` redirect registered in the Enable Banking app. Moneo uses `https://localhost:3443/api/bank/callback` (a local listener with a cert from `npm run setup`), which forwards to `NEXT_PUBLIC_APP_URL`.
- **Scalable Capital** (`lib/scalable/server.ts`): dynamic client registration with `NEXT_PUBLIC_APP_URL/api/scalable/callback`. `localhost` registers freely; other hosts need Scalable's allowlist (it rejects `*.ts.net`).
- **Supabase** (`NEXT_PUBLIC_SUPABASE_URL`, `127.0.0.1:54321`): only the server may call it; never send the browser there, or it breaks on other devices.
- **Phone and tablet** (`*.ts.net` through Tailscale Serve): the laptop's addresses above never change. The three logins refuse to start from a remote device (`lib/remote-device.ts`) and say to use the computer; everything else, including sync, works from there.
- **Voice** needs a secure context (https or localhost) for the microphone.

## Database changes

Add a new ordered migration in `supabase/migrations/` and keep `lib/schema.ts` aligned. Never rewrite an applied migration. `npm run setup` applies pending ones and records them in `supabase_migrations.schema_migrations`. For other Supabase CLI commands use `npx supabase ... --db-url "$SUPABASE_DB_URL"` (from `.env`).

## Tests

A test earns its place by failing when real behaviour breaks. Before writing one, name the bug it would catch.

- **Write tests for** money math, imports and undo, auth, RLS and AI scopes, concurrency, and bugs that actually happened (name the PR or issue).
- **Don't write tests that** assert UI copy or labels, grep source or migration files, mirror the implementation, or need more than about three `vi.mock`s to run. Test the `lib/` function instead.
- One test per behaviour. Don't add a test per requirement or per audit finding; if an existing test covers the failure, extend it.
- `npm test` must pass with no `.env`, no Docker and no network. Anything that needs the database is a `*.live.test.ts`.
- Use fake timers or controlled promises, never real waits. Mock AI, bank and Scalable; real calls are opt-in only.
- Browser specs are for whole user journeys, not single links or labels. Add a spec only when no existing journey can take the check.
- When you remove a feature, remove its tests. Never delete or skip a failing test just to get green: fix the cause, or ask.
- If a pointless test lands, find out why the agent wrote it and fix the guidance here.

Run the smallest relevant test while iterating. Before finishing, run `npm test`, `npm run lint` and `npm run typecheck`; add `npm run build` for app, config or build changes, and Playwright for changed user flows. CI runs the same checks on every pull request.

## Commits and pull requests

- Break the work into steps and commit each one; a big task is several commits.
- Write commit messages in plain language: what changed and why.
- Deferred work gets their issue created on github.
- suggest edits in agents.md if there was something that is changed or needs to be there in agents.md but only suggest when it is actually needed dont suggest just for suggesting.(only for prs)

## Context

Read only what the task needs: `.env.example` for environment names, `e2e/README.md` for browser tests, `supabase/tests/README.md` for SQL checks.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
