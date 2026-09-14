# Moneo — AI-Native Personal Finance Workspace

Personal finance walking skeleton through epochs 1–6: authentication, statement
imports, canonical accounts/transactions, corrections and grounded AI chat.
See [the implementation epochs](docs/IMPLEMENTATION-EPOCHS.md),
[product specification](docs/ai_native_personal_finance_product_spec_v7.md), and
[architecture](docs/personal_finance_technical_architecture_v11.md).

## Prerequisites

- Node.js >= 20.19
- pnpm >= 10 (`npm install -g pnpm`)
- Docker (for Postgres / Redis / MinIO)

## Quickstart (fresh clone)

```sh
cp .env.example .env
pnpm install
pnpm --recursive --filter './packages/**' build
pnpm dev:infra:up
pnpm db:migrate
pnpm --filter @moneo/db exec tsx scripts/setup-local.ts
pnpm db:seed
pnpm dev        # web on :3000, worker alongside
```

Before starting the app, configure the Auth0 EU tenant/application and management
credentials in `.env`, including the callback/logout URLs and strong-auth setup.
Finance access requires sign-in and passkey/TOTP enrollment. Configure
`SEARCH_CURSOR_SECRET` for transaction pagination and `OPENROUTER_API_KEY` for
Included AI. The local setup script creates random passwords for the restricted
database roles and writes them privately to `.env`; rerunning it rotates those
passwords, so restart running services afterward.

Create the private `moneo-quarantine` bucket in the MinIO console at
`http://localhost:9001` (development credentials are in `.env.example`). Uploaded
bytes now use S3 storage shared by the web app and worker.

To try the milestone, add a manual account/current balance or import a CSV/XLSX
statement, open Money → Transactions, correct a category, then ask the assistant
about that category and date range with an explicit currency. Open its Evidence
link to inspect the deterministic result. The panel and `/ai` share a conversation.

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
/apps/worker    Durable import jobs + outbox/BullMQ dispatch
/packages/db       Drizzle ORM + migrations + currency seed
/packages/finance  Canonical finance domain and deterministic tools
/packages/forecast  Deterministic forecasting (later epochs)
/packages/ai        OpenRouter gateway + bounded financial assistant
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

The worker also requires `OUTBOX_DATABASE_URL`, a separate PostgreSQL login
granted only the `moneo_dispatcher` role. Migration 0023 creates that role as
`NOLOGIN NOBYPASSRLS`; deployment must provision its login/password separately.
For local Postgres after migrating:

```sh
pnpm --filter @moneo/db exec tsx scripts/setup-local.ts
```

## AI configuration

Included AI uses `inclusionai/ling-3.0-flash-fin:free`; Custom AI can also select
`google/gemma-4-31b-it:free`. Requests enforce zero prompt/completion pricing and
deny provider data collection. Provider quota/privacy failures surface as errors;
there is no paid-model or different-credential fallback.

Custom keys use envelope encryption. Development needs a separate 32-byte base64
`AI_CREDENTIAL_ENCRYPTION_KEY`. Staging/production require
`AI_CREDENTIAL_KMS_KEY_ID`, conventionally
`alias/finance-{environment}-user-credentials`, and AWS SDK region/credentials with
`kms:GenerateDataKey` and `kms:Decrypt` on that key. Encryption context binds the
workspace, environment and purpose. Local envelopes are refused in staging and
production. Credential operations require a recent sign-in; only workspace owners
can change AI settings or credentials.

## Verification

Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm build`, and
`pnpm --filter @moneo/web test:e2e`. Run
`pnpm --filter @moneo/db exec tsx scripts/ai-smoke.ts` for a real OpenRouter call
using temporary synthetic finance data. Set `MONEO_AI_SMOKE_MODE=custom` to test
encrypted custom credentials. These smoke tests remove their synthetic workspace.

See [the epochs 1–6 review](docs/EPOCHS-1-6-REVIEW.md) for fixes and verification limits.
