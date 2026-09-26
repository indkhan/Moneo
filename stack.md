# Architecture Decisions

Desktop-first finance website. Personal use first, other users later. CSV/Excel and manual entry first; read-only bank connections later.

## Stack

| Purpose | Choice |
|---|---|
| Website/backend | Next.js + React + TypeScript on Vercel |
| Database/login/files | Supabase PostgreSQL + Auth + Storage |
| Background jobs | Vercel Workflows |
| AI | OpenRouter free models + Vercel AI SDK |
| UI | shadcn/ui + Tailwind CSS |
| Data/tables/charts | TanStack Query + Table + Apache ECharts |
| Queries/validation | Drizzle ORM + Zod |
| CSV/Excel parsing | Papa Parse + ExcelJS |
| Code editor | CodeMirror |
| Tests | Vitest + Playwright |

## Design

One TypeScript codebase with shared, exact financial calculations. AI uses controlled tools, not raw database access. Preserve source records, evidence, corrections, and undo.

Once started by the deployed backend, workflows continue after the browser closes. Use bounded, retry-safe steps, cancellation, and Supabase for user-visible progress and saved results.

Enforce workspace isolation, authorization, and row-level security from day one. Keep secrets server-side.

Isolate generated tools behind a controlled Finance SDK. Prototype QuickJS/WASM in a browser Web Worker; validate before relying on it.

## Development constraints

Free tiers only; no paid-model fallback. Training on the founder's authorized development data is accepted, not future users' data. Independent backups deferred.

No Redis, separate hosted worker, Python backend, microservices, vector database, or heavy agent framework initially.
