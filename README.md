# Moneo

Moneo is a personal finance workspace for importing transactions, tracking accounts, planning spending, and exploring your finances with AI. It is a Next.js and TypeScript app backed by Supabase.

## Run locally

1. Install dependencies: `npm ci`
2. Copy `.env.example` to `.env` and add your Supabase URL and publishable key. Add `SUPABASE_SERVICE_ROLE_KEY` for import and analysis workflows, and `OPENROUTER_API_KEY` for AI features.
3. Apply the SQL files in `supabase/migrations/` to your Supabase project in filename order. Configure Supabase email sign-in with `http://localhost:3000/auth/callback` as an allowed redirect URL.
4. Start the app: `npm run dev`, then open [http://localhost:3000](http://localhost:3000).

Without Supabase keys, the home page shows a setup message. Keep `.env` private; it is git-ignored.

## Checks

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run test:e2e` | Playwright browser tests |

The browser tests include a live-backend journey that skips until its prerequisites are configured; see [e2e/README.md](e2e/README.md).

## Project notes

- [Product plan](plan.md)
- [Architecture and stack](stack.md)
- [End-to-end test setup and coverage](e2e/README.md)
