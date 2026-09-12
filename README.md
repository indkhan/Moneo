# Moneo — AI-Native Personal Finance Workspace

Epoch 0 engineering foundation. See `IMPLEMENTATION-EPOCHS.md` (Epoch 0) for the
implementation contract and `personal_finance_technical_architecture_v11.md` for
technical invariants.

## Prerequisites

- Node.js >= 20.19
- pnpm >= 10 (`npm install -g pnpm`)
- Docker (for Postgres / Redis / MinIO)

## Quickstart (fresh clone)

```sh
cp .env.example .env
pnpm install
pnpm dev:infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev        # web on :3000, worker alongside
```

Visit:

- `/home`, `/money`, `/plan`, `/ai`, `/settings`
- `GET /api/v1/health`
- `GET /api/v1/version` → `{ gitSha, releaseId, schemaVersion, environment }`

## Scripts

| Script               | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `dev:infra:up`       | Start Postgres + Redis + MinIO (S3-compatible)     |
| `dev:infra:down`     | Stop dependencies                                  |
| `dev:reset`          | Stop dependencies and delete volumes               |
| `db:migrate`         | Release-time migration runner (never runs on boot) |
| `db:seed`            | Seed ISO 4217 currency metadata                    |
| `lint`               | ESLint over the repo                               |
| `format`             | Prettier check                                     |
| `typecheck`          | `tsc --build` over all workspace projects          |
| `test` / `test:unit` | Vitest unit suites                                 |
| `build`              | Build all workspaces                               |

## Repository shape

```text
/apps/web       Next.js App Router shell + API
/apps/worker    BullMQ worker runtime skeleton
/packages/db       Drizzle ORM + migrations + currency seed
/packages/finance  Canonical finance domain (later epochs)
/packages/forecast  Deterministic forecasting (later epochs)
/packages/ai        Model gateway + capabilities (later epochs)
/packages/artifacts Artifact runtime (later epochs)
/packages/ui        First-party UI primitives (Radix under the hood)
/packages/shared    Env parsing, logging, release identity, exact money
```

## Observability

- Web: `instrumentation.ts` registers `@vercel/otel`; traces export OTLP/HTTP to
  `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`).
- Worker: `NodeSDK` with auto-instrumentations (Postgres, Redis/BullMQ).
- Logs: structured JSON via `pino` with `service`, `environment`, `release`,
  plus `trace_id` / `span_id` correlated from the active span and `request_id`
  where provided.

## Migrations

Migrations apply exactly once through the release pipeline (`pnpm db:migrate`
with `DATABASE_MIGRATION_URL`). Ordinary web/worker boot never migrates.
