# AGENTS.md

Moneo is a Next.js 16 + React 19 + TypeScript personal-finance app using Supabase/Postgres, Drizzle, Vercel Workflow, Vitest/Playwright, and the Vercel AI SDK via OpenRouter.

## Commands

Use npm (`package-lock.json` is authoritative).

- Install: `npm ci`
- Dev: `npm run dev`
- Unit: `npm test`
- Lint: `npm run lint`
- Build: `npm run build`
- E2E: `npm run test:e2e`

## Project map

- `app/` — App Router UI, route handlers, server actions
- `lib/finance/` — deterministic financial logic
- `lib/ai/` — model/provider behavior
- `lib/artifacts/` — generated-tool sandbox/runtime
- `lib/db/schema.ts` + `supabase/migrations/` — database schema
- `workflows/` — durable background jobs
- `e2e/` — Playwright flows

## Rules
- Find the simplest cleanest way of doing something 
- Keep changes scoped; follow nearby patterns and prefer existing utilities/dependencies.
- Validate user/external input; Zod is the established pattern.
- Financial truth comes from application code/data, not AI guesses. Keep money in integer minor units/`bigint` and currencies explicit.
- Preserve source records, correction/history, and undo semantics when changing financial data flows.
- For schema changes, add a new ordered migration and keep `lib/db/schema.ts` aligned. Do not rewrite applied migrations.
- Preserve artifact isolation/validation; do not weaken sandbox or timeout boundaries.
- for each thing break it down and for each thing make a commit directly if a big task make multiple commits

## Validation

Run the smallest relevant test while iterating. Before finishing, run `npm test` and `npm run lint`; add `npm run build` for app/config/build changes and Playwright for changed user flows. Gated E2E requires configured Supabase/auth; see `e2e/README.md`.

## Context
 
 
Read only what the task needs: `plan.md` for product behavior, `.env.example` for environment names, and `e2e/README.md` for browser-test setup.


<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
