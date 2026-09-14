# Epochs 1–6 implementation review

Reviewed against `IMPLEMENTATION-EPOCHS.md`, product spec v7 and technical
architecture v11. Review date: 14 September 2026.

## Outcome and scope

The application now connects the early finance foundation to a working grounded
chat experience. The important architectural boundaries remain intact: tenant
transactions/RLS, audited and versioned finance corrections, durable background
jobs, exact monetary arithmetic, and read-only AI tools. Forecasting, review inbox,
artifacts and dashboards scheduled for later epochs remain outside this milestone.

This is a code and local verification report, not production acceptance of every
external service or every requirement in the eventual product.

## Findings addressed

| Epoch | Finding and resulting behavior                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Finance routes consistently require strong authentication. Primary enrollment accepts passkey/TOTP; revoked sessions cannot become active simply by registering again. AI administration is OWNER-only in both API and UI. Credentials require recent provider authentication. Development CSP permits the evaluation needed by Next dev; production does not.                        |
| 2     | Durable job creation emits an atomic outbox event. Worker dispatch now uses a dedicated restricted role and narrow database functions; the normal app role cannot claim another tenant's outbox. Added lease/retry handling and tenant-bound job-attempt references. Removed the release migration module from the web's runtime exports after it broke bundling.                     |
| 3     | Upload bytes use shared S3 storage instead of process-local memory. Import execution persists source observations, canonicalization, progress and terminal state. Live PostgreSQL smoke covers dispatch, import completion and replay safety. Parser suites cover CSV/XLSX safety and duplicate handling.                                                                             |
| 4     | Preserved exact native-currency calculations, explicit unknown balances and existing FX/matching/manual-account contracts. Transaction detail and evidence links open the corresponding transaction. Mixed-currency AI analytics require an explicit currency rather than producing a false combined total.                                                                           |
| 5     | Added frozen ID/version selections, all-matching selection beyond the loaded page, bulk category/tag/exclusion commands and explicit conflict counts. Saved views restore direction/date/category/tag filters and columns. Fixed hidden table columns. Default workspace categories now make categorization usable before the later category-management feature.                      |
| 6     | Implemented durable conversations/runs/messages, native provider tool calls, streaming responses, shared panel/full chat, cancellation/retry and evidence navigation. Finance tools are strictly validated and cannot accept a model-supplied workspace. Settings support Included/Custom modes, prompts, models, provider credentials, account exclusions and actual usage metadata. |

## Chat and OpenRouter

The default is `inclusionai/ling-3.0-flash-fin:free`, selected for finance and tool
support. Custom mode also offers `google/gemma-4-31b-it:free`.
[OpenRouter's model page](https://openrouter.ai/inclusionai/ling-3.0-flash-fin:free)
describes the finance model. Requests set zero prompt/completion price limits and
deny provider data collection using
[OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).
There is no paid-model or different-credential fallback. Free capacity and account
limits can still produce rate-limit or unavailable-provider errors.

Money comes from deterministic backend tools. Model input receives formatted
amounts, periods, scope and evidence links; no arbitrary SQL or finance mutation
tool is exposed. Runs enforce input/output/tool/result/time/cost limits and record
resolved model/provider/usage when returned. Interrupted streams are errors, not
silently completed answers.

Account exclusions apply before source data enters any tool or model context.
Policy changes invalidate resumed model history and evidence access and cancel
older runs. Dispatch is serialized with policy changes; cancellation aborts the
provider request. Data already transmitted to a provider cannot be recalled.

Custom credentials use AES-GCM envelope encryption. Local development uses a
separate wrapping key; staging/production use AWS KMS with workspace/environment
encryption context. Missing KMS configuration fails closed. The implementation
uses the AWS SDK's
[GenerateDataKey](https://docs.aws.amazon.com/goto/SdkForJavaScriptV3/kms-2014-11-01/GenerateDataKey)
and [Decrypt](https://docs.aws.amazon.com/goto/SdkForJavaScriptV3/kms-2014-11-01/Decrypt)
operations. Keys never appear in browser settings responses or model context.

## Verification

| Check                                   | Result                                                 |
| --------------------------------------- | ------------------------------------------------------ |
| `pnpm test`                             | 827 passed; 2 opt-in integration tests skipped         |
| `pnpm typecheck`                        | Passed                                                 |
| `pnpm lint`                             | Passed with zero warnings                              |
| `pnpm format`                           | Passed                                                 |
| `pnpm build`                            | Passed across all workspaces                           |
| Playwright against Next dev             | 16 passed                                              |
| Playwright against the production build | 16 passed                                              |
| Live OpenRouter Included + Custom       | Both passed, exact synthetic amount and evidence       |
| Live PostgreSQL import                  | Passed, restricted dispatcher and tenant runtime roles |
| `pnpm db:migrate` / `pnpm db:seed`      | Applied through migration 0024; reference data seeded  |
| `git diff --check`                      | Passed                                                 |

The default skipped tests require external integration configuration. The live
import test was separately enabled and passed. Browser screenshots of chat and
transaction controls were inspected.

Live OpenRouter checks passed in both Included and encrypted Custom modes with a
temporary synthetic workspace: one restaurant debit of 1234 EUR minor units in
August 2026 produced an answer of **12.34 EUR** and matching durable evidence.
Only synthetic data was used and the smoke workspaces were removed.

The live import smoke passed against PostgreSQL with `moneo_dispatcher` as the
outbox connection and `moneo_app` as the finance runtime. It tests canonical rows
and idempotent completion, using an in-memory object store/queue transport in the
smoke harness. It is not a live Redis/MinIO acceptance test.

## Remaining operational validation and limits

- Docker's Linux engine is unavailable on this machine. A full web → MinIO →
  Redis/BullMQ → worker run remains to be validated with those services running.
- Browser tests cover logged-out security and mocked authenticated data/chat
  responses. Real Auth0 sign-in, passkey enrollment and fresh-auth credential
  management still need validation against the configured tenant.
- AWS KMS encryption is tested with an injected KMS service; actual IAM policies,
  key aliases, region and deployed KMS connectivity need a live environment.
- Frozen bulk selections are bounded at 10,000 rows and processed synchronously
  with per-row idempotency. Very large asynchronous bulk workflows and a grouped
  bulk-undo interface remain outside the current implementation; individual
  transaction corrections retain their existing safe undo behavior.
- AI source loading currently has an explicit 10,000 eligible-transaction cap.
  Larger workspaces fail clearly instead of silently calculating partial totals.
  Scalable SQL-backed tool queries are the next step for larger histories.
- Chat analytics report one native currency per query. Existing FX valuation tests
  do not constitute a live historical-rate-provider validation. Merchant
  normalization and review status filters belong to their later domains.
- The Auth0 SDK emits a nonfatal dynamic-import warning during Next builds.

## Running the milestone

Follow the repository README. Migrate and seed, provision restricted local
database credentials, start PostgreSQL/Redis/MinIO, create the private upload
bucket, and configure Auth0 and OpenRouter. Sign in and complete strong auth.
Import a statement or record manual transactions, choose a category, and ask about
that category and period in an explicit currency. Compare the answer with Evidence
and the filtered transaction list. Default categories include Dining & Cafés.

`scripts/setup-local.ts` only accepts a development configuration and loopback
PostgreSQL. It rotates the two runtime role passwords and updates `.env` privately;
restart services afterward. No application secret is committed by this review.
