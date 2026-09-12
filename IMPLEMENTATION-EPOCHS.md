# AI-Native Personal Finance Workspace — Implementation Epochs

**Status:** Execution specification  
**Architecture source of truth:** `personal_finance_technical_architecture_v11.md`  
**Product source of truth:** `ai_native_personal_finance_product_spec_v7.md`  
**Purpose:** Turn the approved product and technical architecture into a sequential implementation plan that can be executed by engineers or coding agents with minimal ambiguity.

---

# 0. How to Use This Document

This is not a roadmap-only document. Each epoch is an **implementation contract**.

An engineer or coding agent should:

1. Work only on the current issue/task unless an explicit dependency requires touching another task.
2. Follow the architecture source of truth rather than inventing alternate patterns.
3. Keep each commit buildable and testable.
4. Never weaken RLS, idempotency, exact-money arithmetic, auditability, privacy, or security to make implementation easier.
5. Update the architecture/spec only when implementation proves an existing decision is invalid.
6. Run the epoch-level manual/computer-use acceptance test before calling the epoch complete.

Do **not** implement later epochs early just because it seems convenient.

The intended progression is:

```text
Foundation
   ↓
Identity + tenancy
   ↓
Reliable mutations + durable jobs
   ↓
Import source data
   ↓
Canonical finance model
   ↓
Corrections + audit
   ↓
Grounded AI
   ↓
Finance intelligence
   ↓
Planning + forecast
   ↓
AI-native workflows
   ↓
Artifacts
   ↓
Privacy/security/ops hardening
   ↓
Closed beta
```

---

# 1. Global Engineering Contract

## 1.1 Repository Shape

Target monorepo:

```text
/apps
  /web
  /worker

/packages
  /db
  /finance
  /forecast
  /ai
  /artifacts
  /ui
  /shared
```

Feature code inside `apps/web` should be organized by product feature:

```text
/apps/web/src/features
  /dashboard
  /transactions
  /accounts
  /recurring
  /goals
  /scenarios
  /forecast
  /ai-chat
  /artifacts
  /jobs
  /notifications
```

Avoid giant catch-all directories unless the code is genuinely cross-feature.

## 1.2 Non-Negotiable Architecture Rules

### Finance state

- PostgreSQL is canonical.
- Chat history/model memory is never canonical financial truth.
- Raw source observations are preserved.
- Canonical state changes only through typed domain commands.
- Derived state is rebuildable.

### Money

- No authoritative floating-point money.
- Monetary values are integer minor units + currency.
- FX/ratios/investment quantities use exact decimal types.

### Tenancy

- Tenant-owned tables include `workspace_id`.
- Tenant-owned PKs are `(workspace_id, id)`.
- Tenant-owned relationships include `workspace_id` in the FK.
- Application authorization + tool scopes + PostgreSQL RLS all apply.
- Runtime DB role never bypasses RLS.

### Mutations

Every canonical mutation supports:

```text
idempotency
optimistic concurrency
audit
structured errors
undo when applicable
outbox emission where downstream work is needed
```

### AI

- AI uses typed Finance Tools only.
- No SQL or generic DB tools.
- Structured outputs are schema validated.
- Tool scopes remain product-controlled in Custom AI mode.
- Long workflows are durable/checkpointed.
- Financial arithmetic comes from deterministic tools.

### Background work

- PostgreSQL stores durable job/workflow truth.
- BullMQ/Redis is execution transport.
- At-least-once delivery is assumed.
- Business-relevant worker steps are idempotent.

### Artifacts

- Generated JS never runs with main app DOM/browser authority.
- No direct networking.
- No credentials/tokens.
- Canonical writes are host-mediated explicit actions.

---

# 2. Global Pull Request / Commit Rules

Recommended issue implementation order:

```text
1. schema / contract
2. backend/domain
3. API/tool adapter
4. frontend
5. tests
6. observability/docs cleanup
```

Keep commits small and coherent.

Example commits:

```text
feat(db): add canonical transaction tables
feat(finance): implement transaction search query
feat(api): expose cursor-based transactions endpoint
feat(web): add virtualized transaction table
test(transactions): cover cursor stability
```

---

# 3. Global Definition of Done

Every task/epoch must satisfy the relevant subset of:

```text
[ ] TypeScript passes
[ ] lint/format passes
[ ] unit tests pass
[ ] integration tests pass
[ ] relevant Playwright path passes
[ ] migrations apply from previous schema
[ ] migration safety reviewed
[ ] RLS/tenant tests added where relevant
[ ] OpenAPI regenerated and reviewed
[ ] generated frontend client regenerated
[ ] structured error behavior implemented
[ ] observability spans/logs/metrics added
[ ] loading/empty/error states implemented
[ ] changed UI passes accessibility checks
[ ] no authoritative floating-point money path introduced
[ ] no business logic duplicated across UI/API/AI
[ ] feature can be safely disabled when incomplete
```

AI work additionally requires:

```text
[ ] tool allowlist tested
[ ] structured output schema tested
[ ] max steps/tokens/time/cost tested
[ ] prompt-injection cases tested
[ ] numeric claims grounded in deterministic tools
```

---

# 4. Shared Synthetic Fixtures

Create deterministic synthetic datasets before real finance features grow.

Required fixture families:

```text
basic-single-account
multi-account
duplicates
transfers
recurring
travel-event
salary-change
goal-risk
foreign-currency
investment-manual
malformed-import
tenant-isolation
```

Reuse these fixtures for:

```text
unit tests
integration tests
Playwright
AI evals
forecast evals
artifact smoke tests
```

Never copy raw production data into tests, preview, or staging.

---

# 5. Epoch Map

```text
Wave 0 — Foundation
  E0  Engineering foundation
  E1  Auth + Workspace + RLS
  E2  Commands + Audit + Outbox + Jobs

Wave 1 — First real product
  E3  Import upload + raw source layer
  E4  Canonical accounts + transactions
  E5  Corrections + categories + audit/undo
  E6  Grounded finance AI chat

Wave 2 — Finance intelligence
  E7  Merchant normalization + Review inbox
  E8  Transfers + recurring + financial events
  E9  Goals + rules + assumptions + financial model
  E10 Forecast + Available to Spend + scenarios

Wave 3 — AI-native workspace
  E11 Recommendations + Home dashboard
  E12 Deep Analysis
  E13 Artifact runtime security boundary
  E14 Artifact generation + Library + editor

Wave 4 — Product breadth
  E15 Spending plans + conflicts
  E16 Investments + Assets & Debt
  E17 Notifications + scheduling
  E18 Export + deletion + security UX

Wave 5 — Production hardening
  E19 Observability + backups + DR
  E20 Security hardening + external review gate
  E21 Closed beta gate
```

---

# EPOCH 0 — Engineering Foundation

## Objective

Create a production-shaped monorepo, local stack, CI pipeline, worker runtime, and deployable application shell before product complexity begins.

## Dependencies

None.

## User-visible outcome

A polished shell exists with Home, Money, Plan, AI, and Settings routes. No real finance functionality yet.

## Issue 0.1 — Initialize Monorepo

### Scope

Create:

```text
/apps/web
/apps/worker
/packages/db
/packages/finance
/packages/forecast
/packages/ai
/packages/artifacts
/packages/ui
/packages/shared
```

Configure:

```text
TypeScript strict mode
workspace package manager
shared tsconfig
ESLint
Prettier
environment parsing
package boundaries
```

### Acceptance

```text
install
lint
typecheck
```

all succeed on a fresh clone.

### Commit

```text
chore(repo): initialize finance monorepo
```

---

## Issue 0.2 — Next.js Application Shell

### Build

Routes:

```text
/home
/money
/plan
/ai
/settings
```

Shell:

```text
left navigation
main content region
global job indicator mount
notification mount
persistent AI panel mount
```

Create first-party UI wrappers in `/packages/ui`:

```text
Button
Card
Input
Dialog
Menu
Skeleton
EmptyState
```

Radix is implementation detail behind our UI package.

### Acceptance

- Every route direct-loads.
- Keyboard navigation works.
- Desktop layout remains stable on resize.
- No page depends on mock finance data to render.

### Commit

```text
feat(web): add application shell and core ui primitives
```

---

## Issue 0.3 — Local Infrastructure

Provide local:

```text
PostgreSQL
Redis
S3-compatible storage or storage abstraction
```

Recommended local Docker Compose only.

Scripts:

```text
dev:infra:up
dev:infra:down
dev:reset
```

### Acceptance

One documented command launches required dependencies.

### Commit

```text
chore(dev): add local postgres redis and object storage
```

---

## Issue 0.4 — Database/Drizzle Bootstrap

Implement:

```text
Drizzle ORM
node-postgres
migration directory
migration runner
currencies table
currency seed
```

Seed at least EUR, JPY, BHD plus full intended ISO dataset if practical.

### Tests

Verify currency minor-unit behavior.

### Commit

```text
feat(db): bootstrap drizzle and currency metadata
```

---

## Issue 0.5 — Worker Skeleton

Worker runtime must:

```text
connect Postgres
connect Redis
initialize BullMQ
handle SIGTERM
close gracefully
emit telemetry
```

No business jobs yet.

### Acceptance

Worker can be terminated gracefully without warnings or stuck Redis locks.

### Commit

```text
feat(worker): add bullmq worker runtime skeleton
```

---

## Issue 0.6 — Health and Version API

Add:

```text
GET /api/v1/health
GET /api/v1/version
```

Version response:

```text
gitSha
releaseId
schemaVersion
environment
```

Do not expose credentials/provider connection details.

### Commit

```text
feat(api): add health and release version endpoints
```

---

## Issue 0.7 — Observability Bootstrap

Add OpenTelemetry for:

```text
Next.js
worker
Postgres
Redis
```

Structured logging fields:

```text
service
environment
release
trace_id
span_id
request_id
```

### Acceptance

A staging HTTP request appears in the observability backend with correlated trace/log.

### Commit

```text
feat(obs): add baseline opentelemetry instrumentation
```

---

## Issue 0.8 — CI/CD Skeleton

PR checks:

```text
install
format
lint
typecheck
unit
web build
worker build
Storybook tests
Playwright smoke
CodeQL
dependency scan
secret scan
```

Production environment is protected.

Migrations never run from ordinary app boot.

### Commit

```text
ci: add build quality and security pipeline
```

---

## Epoch 0 Computer-Use Acceptance

Tester can:

1. Clone repository.
2. Start dependencies from README.
3. Apply migrations.
4. Start web + worker.
5. Visit all five main routes.
6. Run tests.
7. Deploy staging.
8. Read `/api/v1/version`.
9. Find one request trace.

## Exit Gate

Do not continue if environment setup still depends on undocumented developer-specific steps.

---

# EPOCH 1 — Authentication, Workspace, RLS

## Objective

Create secure identity, session handling, workspace tenancy, and real PostgreSQL isolation.

## Dependencies

Epoch 0.

## Issue 1.1 — Identity/Workspace Schema

Add:

```text
users
workspaces
workspace_members
security_audit_events
```

Use UUIDv7.

### Commit

```text
feat(db): add user workspace and security audit schema
```

---

## Issue 1.2 — RLS and Runtime DB Roles

Create/document:

```text
application_role NOBYPASSRLS
migration role
```

Implement:

```text
withWorkspaceTransaction(workspaceId, callback)
```

Internally sets transaction-local:

```text
app.current_workspace
```

No tenant domain query should bypass this helper.

### Mandatory tests

```text
A cannot read B
A cannot update B
wrong workspace FK rejected
missing tenant context fails safely
app role cannot bypass RLS
```

### Commit

```text
feat(db): enforce workspace rls and tenant-safe foreign keys
```

---

## Issue 1.3 — Auth0 EU Integration

Configure:

```text
EU tenant
login
logout
callback
custom-domain-ready config
```

Browser session:

```text
Secure
HttpOnly
host-only
SameSite
```

No access/refresh tokens in browser storage.

### Commit

```text
feat(auth): integrate auth0 eu browser sessions
```

---

## Issue 1.4 — User/Workspace Provisioning

First successful identity login:

```text
Auth0 subject
→ users row
→ default workspace
→ OWNER membership
```

Must be idempotent.

### Commit

```text
feat(auth): provision default workspace on first login
```

---

## Issue 1.5 — Connect Authenticated Shell

Display:

```text
current user
current workspace
logout
settings identity
```

### Commit

```text
feat(web): connect shell to authenticated workspace
```

---

## Issue 1.6 — CSRF and Browser Security Baseline

Implement:

```text
SameSite
CSRF token
Origin verification
Fetch Metadata verification
CSP
HSTS production config
X-Content-Type-Options
Referrer-Policy
Permissions-Policy
```

### Tests

- invalid Origin write rejected
- missing CSRF rejected
- GET cannot mutate

### Commit

```text
security(web): add csrf and baseline browser hardening
```

---

## Issue 1.7 — Session Security UI

Settings → Privacy & Security skeleton:

```text
current session
sign out
sign out other sessions
```

### Commit

```text
feat(settings): add initial session security controls
```

---

## Epoch 1 Acceptance

1. Create User A and B.
2. Confirm independent workspaces.
3. Try to access B object while authenticated as A.
4. Confirm deny at app and DB layers.
5. Verify secure cookie flags.
6. Verify cross-origin write rejection.

---

# EPOCH 2 — Command Infrastructure, Audit, Outbox, Jobs

## Objective

Build reliable mutations and background execution once before finance state depends on them.

## Issue 2.1 — Command/Audit/Outbox Schema

Add:

```text
command_operations
audit_events
outbox_events
```

Unique:

```text
(workspace_id, command_name, idempotency_key)
```

### Commit

```text
feat(db): add command audit and outbox schema
```

---

## Issue 2.2 — Command Executor

Reusable command lifecycle:

```text
authorize
claim idempotency
load state
check expected version
validate invariant
mutate
increment version
audit
outbox
store command result
commit
```

### Commit

```text
feat(finance): add idempotent command executor
```

---

## Issue 2.3 — Problem Details Errors

Implement machine-readable domain error mapping.

Required codes:

```text
VALIDATION_FAILED
NOT_FOUND
FORBIDDEN
VERSION_CONFLICT
IDEMPOTENCY_KEY_REUSED
RATE_LIMITED
JOB_REQUIRED
UNKNOWN_OUTCOME
INVARIANT_VIOLATION
DEPENDENCY_UNAVAILABLE
```

### Commit

```text
feat(api): standardize problem-details responses
```

---

## Issue 2.4 — Durable Job Schema

Add:

```text
background_jobs
background_job_attempts
scheduled_tasks
```

### Commit

```text
feat(db): add durable job and schedule schema
```

---

## Issue 2.5 — Outbox Dispatcher

Implement PostgreSQL claim using:

```text
FOR UPDATE SKIP LOCKED
```

Publish deterministic BullMQ job ID.

Duplicate publish must be safe.

### Commit

```text
feat(worker): add transactional outbox dispatcher
```

---

## Issue 2.6 — Generic Worker Lifecycle

Worker:

```text
load durable job
check cancellation/terminal state
create attempt
mark running
heartbeat
execute
mark success/final failure/cancelled
```

### Commit

```text
feat(worker): implement durable job execution lifecycle
```

---

## Issue 2.7 — Retry Classification

Implement:

```text
TRANSIENT
PERMANENT_INPUT
PERMANENT_POLICY
UNKNOWN_EXTERNAL_OUTCOME
BUG_INVARIANT
```

Bound retries + jitter.

### Commit

```text
feat(worker): add classified retry handling
```

---

## Issue 2.8 — Global Job UI

Add:

```text
running job indicator
job detail drawer
progress stage
Stop
Retry when eligible
```

### Commit

```text
feat(web): add durable job status ui
```

---

## Epoch 2 Acceptance

Simulate:

```text
command succeeds
outbox publish duplicated
worker crashes
same queue job delivered twice
```

Expected: one business effect, complete audit trail, understandable attempt history.

---

# EPOCH 3 — Import Upload + Raw Source Layer

## Objective

Safely ingest CSV/XLSX and preserve source observations without requiring perfect normalization.

## Issue 3.1 — Source Schema

Add:

```text
data_sources
imports
source_accounts
source_transactions
source_transaction_observations
```

### Commit

```text
feat(db): add source ingestion schema
```

---

## Issue 3.2 — Private Upload Flow

Implement:

```text
initiate upload
quarantine object
complete upload
store metadata
```

No public URLs.

### Commit

```text
feat(imports): add private statement upload flow
```

---

## Issue 3.3 — Safe CSV Parser

Support:

```text
delimiter detection
encoding handling
header preview
row bounds
cell bounds
```

### Commit

```text
feat(imports): add bounded csv parser
```

---

## Issue 3.4 — Safe XLSX Parser

Enforce:

```text
ZIP entry count
uncompressed size
macro rejection
formula non-execution
no external resource loading
CPU/memory bounds
```

### Commit

```text
feat(imports): add hardened xlsx parser
```

---

## Issue 3.5 — Column Mapping

Map:

```text
date
description
amount
currency
direction/credit/debit
account
```

Provide:

```text
auto detection
manual fallback
preview
```

### Commit

```text
feat(imports): add statement column mapping
```

---

## Issue 3.6 — Durable Import Workflow

Stages:

```text
FILE_VALIDATION
PARSE
SOURCE_ACCOUNT_DETECTION
SOURCE_TRANSACTION_UPSERT
IMPORT_SUMMARY
```

Batch processing.

### Commit

```text
feat(worker): add durable statement import workflow
```

---

## Issue 3.7 — Import Wizard

UI:

```text
upload
preview
mapping
account
processing
summary
```

Browser can be closed during processing.

### Commit

```text
feat(web): add financial statement import wizard
```

---

## Issue 3.8 — Duplicate File Detection

Use file hash as a warning/signal, not a permanent uniqueness rule.

### Commit

```text
feat(imports): detect repeated source files
```

---

## Epoch 3 Acceptance

Test fixtures:

```text
clean CSV
clean XLSX
duplicate file
identical legitimate rows
malformed rows
formula cells
macro file
zip bomb simulation
cancelled import
worker retry
```

---

# EPOCH 4 — Canonical Accounts + Transactions

## Objective

Turn source observations into usable Money screens.

## Issue 4.1 — Canonical Account Schema

Add:

```text
accounts
account_source_links
account_balance_snapshots
```

### Commit

```text
feat(db): add canonical account model
```

---

## Issue 4.2 — Canonical Transaction Schema

Add:

```text
transactions
transaction_source_links
```

Indexes:

```text
(workspace_id, effective_date DESC)
(account_id, effective_date DESC)
```

### Commit

```text
feat(db): add canonical transaction model
```

---

## Issue 4.3 — Canonicalization Service

Implement:

```text
source account → account
source transaction → transaction
source links
```

Never delete raw source history.

### Commit

```text
feat(finance): canonicalize imported financial data
```

---

## Issue 4.4 — Exact Money Utilities

Implement shared:

```text
localized amount parser
minor-unit conversion
currency exponent
currency formatter
safe integer checks
```

Never use `parseFloat(x) * 100` as authoritative conversion.

### Commit

```text
feat(shared): add exact money utilities
```

---

## Issue 4.5 — Account Queries

Implement:

```text
accounts.list
accounts.get
accounts.getBalances
```

### Commit

```text
feat(finance): add account query services
```

---

## Issue 4.6 — Transaction Search

Typed search supports:

```text
accountIds
dateRange
directions
amount range
text
sort
limit
cursor
```

Default keyset:

```text
effective_date DESC, id DESC
```

Opaque signed cursor.

### Commit

```text
feat(finance): add cursor-based transaction search
```

---

## Issue 4.7 — Money Screens

Implement:

```text
Money → Overview minimal
Money → Accounts
Money → Transactions
```

Transactions use:

```text
TanStack Query useInfiniteQuery
TanStack Table
TanStack Virtual
server-side filter/sort
```

### Commit

```text
feat(web): add accounts and transactions experience
```

---

## Issue 4.8 — Transaction Detail Drawer

Display:

```text
canonical fields
source/import
View original
```

Preserve list/filter state when opened.

### Commit

```text
feat(web): add transaction detail drawer
```

---

## Epoch 4 Acceptance

Import a large fixture and browse it without loading the entire dataset into the browser.

Cursor ordering must remain deterministic when many transactions share the same date.

---

# EPOCH 5 — Corrections, Categories, Tags, Audit, Undo

## Issue 5.1 — Categorization Schema

Add:

```text
system_categories
categories
counterparties
tags
transaction_tags
transaction_relations
```

### Commit

```text
feat(db): add categories tags and counterparties
```

---

## Issue 5.2 — Entity Versions

Add `version BIGINT` to mutable canonical objects that require conflict protection.

### Commit

```text
feat(finance): add optimistic entity versions
```

---

## Issue 5.3 — Transaction Correction Commands

Implement:

```text
transactions.setCategory
transactions.setCounterparty
transactions.addTags
transactions.removeTags
transactions.setNote
transactions.excludeFromAnalytics
```

### Commit

```text
feat(finance): add transaction correction commands
```

---

## Issue 5.4 — Undo

Implement compensating-command registry.

Return:

```text
operationId
undoAvailable
```

Undo checks current version.

### Commit

```text
feat(finance): add safe compensating undo
```

---

## Issue 5.5 — Correction UI

Transaction drawer supports:

```text
category
merchant
Tags
note
exclude from analytics
```

Use optimistic UI only where rollback is safe.

### Commit

```text
feat(web): add transaction correction controls
```

---

## Issue 5.6 — Audit History

Show:

```text
actor
old/new
reason
time
related AI run
```

### Commit

```text
feat(web): add finance audit history ui
```

---

## Epoch 5 Acceptance

Open same transaction in two tabs.

Tab A changes category.
Tab B submits stale version.

Expected:

```text
VERSION_CONFLICT
no silent overwrite
```

Undo after a newer change must fail safely rather than overwrite newer state.

---

# EPOCH 6 — Grounded Finance AI Chat

## Objective

Deliver the first core differentiator: AI grounded in real finance data.

## Issue 6.1 — AI Persistence Schema

Add:

```text
conversations
messages
ai_capabilities
ai_capability_versions
workspace_ai_config
workspace_ai_capability_overrides
ai_runs
ai_model_calls
ai_tool_calls
```

### Commit

```text
feat(db): add ai conversation and run persistence
```

---

## Issue 6.2 — Model Gateway

Internal abstraction:

```text
generate
stream
generateStructured
```

OpenRouter adapter records:

```text
requested model
resolved model/provider
input/output/cached tokens
cost
latency
finish reason
```

### Commit

```text
feat(ai): add provider-independent model gateway
```

---

## Issue 6.3 — Financial Assistant Capability

Configure:

```text
prompt version
model policy
provider privacy policy
tool set
budgets
```

### Commit

```text
feat(ai): add versioned financial assistant capability
```

---

## Issue 6.4 — Deterministic Finance Query Tools

Implement:

```text
accounts.list
accounts.getBalances
transactions.search
transactions.get
analytics.cashflow
analytics.spendingByCategory
analytics.spendingByCounterparty
analytics.comparePeriods
```

### Commit

```text
feat(finance): add grounded analytics tools
```

---

## Issue 6.5 — AI Tool Registry

Metadata:

```text
READ_ONLY
scopes
input schema
output schema
limits
retry class
```

Workspace identity is server-injected, never model-provided.

### Commit

```text
feat(ai): expose finance query tools to assistant
```

---

## Issue 6.6 — Bounded Agent Loop

Hard limits:

```text
model turns
tool calls
parallel calls
input/output tokens
wall time
cost
result bytes
```

### Commit

```text
feat(ai): implement bounded finance assistant loop
```

---

## Issue 6.7 — Evidence References

Analytics return:

```text
result
evidenceRef
dataCutoff
calculationMetadata
```

Evidence view resolves exact filters/contributing rows.

### Commit

```text
feat(finance): add evidence references for analytics
```

---

## Issue 6.8 — Chat UI

AI → Chat:

```text
thread list
streamed text
structured tool activity
evidence cards
Stop
error recovery
```

Use AI SDK UI custom transport into our own orchestration backend.

### Commit

```text
feat(web): add grounded finance chat
```

---

## Issue 6.9 — Eval Harness

Synthetic questions:

```text
How much did I spend last month?
What were my top grocery merchants?
How much income did I receive?
Compare August with July.
Why was August more expensive?
```

Include malicious merchant descriptions pretending to be instructions.

Metrics:

```text
numeric correctness
tool selection
evidence correctness
unsupported-claim rate
```

### Commit

```text
test(ai): add financial assistant eval suite
```

---

## Epoch 6 Acceptance

Ask:

> How much did I spend on restaurants last month?

The answer must match deterministic backend calculation and expose evidence.

**This is the first true walking-skeleton milestone.**

---

# EPOCH 7 — Merchant Normalization + Review Inbox

## Issue 7.1 — Review Model

Add:

```text
review_items
normalization confidence/provenance
counterparty alias support if needed
```

### Commit

```text
feat(db): add financial review model
```

---

## Issue 7.2 — Transaction Classifier

Structured result:

```text
category
confidence
reasonCode
evidenceRefs
```

No free-form data persistence.

### Commit

```text
feat(ai): add transaction classification capability
```

---

## Issue 7.3 — Merchant Normalizer

High-confidence → automatic.

Medium/low → review.

### Commit

```text
feat(ai): add merchant normalization capability
```

---

## Issue 7.4 — Review Generation

Initial types:

```text
UNKNOWN_MERCHANT
UNCERTAIN_CATEGORY
POSSIBLE_DUPLICATE
UNUSUAL_TRANSACTION
```

### Commit

```text
feat(finance): generate financial review items
```

---

## Issue 7.5 — Review UI

Tabs:

```text
Needs attention
Uncertain
Possible duplicates
Unusual
Resolved
```

### Commit

```text
feat(web): add financial review inbox
```

---

# EPOCH 8 — Transfers, Recurring, Financial Events

## Issue 8.1 — Transfer Model

Add:

```text
transfers
transfer_transactions
```

Commands:

```text
confirm
reject
```

### Commit

```text
feat(finance): add transfer model and commands
```

---

## Issue 8.2 — Transfer Detection

Signals:

```text
amount
opposite direction
date proximity
owned accounts
currency/FX
```

Confirmed transfer must not count as spending + income.

### Commit

```text
feat(finance): detect own-account transfer candidates
```

---

## Issue 8.3 — Recurring Model

Add:

```text
recurring_series
recurring_series_transactions
```

### Commit

```text
feat(db): add recurring stream model
```

---

## Issue 8.4 — Recurring Detection

Infer:

```text
cadence
amount range
next date
confidence
```

### Commit

```text
feat(finance): detect recurring transaction streams
```

---

## Issue 8.5 — Financial Events

Add:

```text
financial_events
financial_event_transactions
```

### Commit

```text
feat(finance): add financial event grouping
```

---

## Issue 8.6 — UI

Implement:

```text
Money → Recurring
Review → Transfers
Review → Recurring
```

Recurring detail:

```text
history
annual cost
price change
next expected
confidence
```

### Commit

```text
feat(web): add transfers recurring and event experience
```

---

# EPOCH 9 — Goals, Rules, Assumptions, Financial Model

## Issue 9.1 — Goals

Add:

```text
goals
goal_allocations
goal_contribution_plans
```

### Commit

```text
feat(db): add goal planning model
```

---

## Issue 9.2 — Financial Rules

Add typed rules:

```text
MIN_ACCOUNT_BALANCE
ASSET_NOT_SPENDABLE
TRANSFER_COUNTS_AS_SAVINGS
ACCOUNT_EXCLUDED_FROM_AVAILABLE_CASH
```

Validate each config by rule type.

### Commit

```text
feat(finance): add deterministic financial rules
```

---

## Issue 9.3 — Financial Assumptions

Add versioned/superseding assumptions.

Origins:

```text
USER
INFERRED
SYSTEM
IMPORTED
```

User-confirmed values outrank inference.

### Commit

```text
feat(finance): add versioned financial assumptions
```

---

## Issue 9.4 — AI Preferences

Separate from deterministic rules.

### Commit

```text
feat(ai): add ai preferences
```

---

## Issue 9.5 — Financial Model Resolver

Resolve:

```text
goals
allocations
rules
assumptions
recurring
balances
plans
```

Every resolved field exposes source/confidence.

### Commit

```text
feat(finance): resolve inspectable financial model
```

---

## Issue 9.6 — Planning UI

Implement:

```text
Plan → Overview skeleton
Plan → Goals
Plan → Financial Model
Settings → Financial Rules
```

### Commit

```text
feat(web): add goals rules and financial model ui
```

---

## Issue 9.7 — AI Write Policy

Allow selected canonical planning tools only for explicit user intent.

Example allowed:

```text
Set my emergency cash floor to €500.
```

Example not allowed:

```text
Why is my available cash low?
```

must not silently mutate a rule.

### Commit

```text
feat(ai): gate canonical planning writes by explicit intent
```

---

# EPOCH 10 — Forecast, Available to Spend, Scenarios

## Issue 10.1 — Forecast Schema

Add:

```text
scenarios
scenario_overrides
financial_model_snapshots
forecast_runs
forecast_series
forecast_quantile_points
forecast_events
forecast_component_models
forecast_accuracy_evaluations
plan_conflicts
```

### Commit

```text
feat(db): add forecast and scenario persistence
```

---

## Issue 10.2 — Deterministic Forecast Timeline

Implement:

```text
daily timeline
starting balances
deterministic future events
account-level cash flow
```

### Commit

```text
feat(forecast): add deterministic cashflow timeline
```

---

## Issue 10.3 — Recurring Uncertainty

Model:

```text
amount distribution
date jitter
confidence
```

### Commit

```text
feat(forecast): model recurring uncertainty
```

---

## Issue 10.4 — Variable Spending Models

Initial candidates:

```text
robust recent average
EWMA
simple exponential smoothing
naive
seasonal naive when eligible
```

Weekly/category level with hierarchical fallback.

### Commit

```text
feat(forecast): add interpretable variable spend models
```

---

## Issue 10.5 — Probabilistic Simulation

Seeded simulation.

Output arbitrary quantiles, initially:

```text
P10
P50
P90
```

### Commit

```text
feat(forecast): add reproducible probabilistic simulation
```

---

## Issue 10.6 — Available to Spend

Default:

```text
30-day horizon
90% confidence
P10 minimum-liquidity margin
```

Expose calculation breakdown.

### Commit

```text
feat(forecast): calculate risk-adjusted available-to-spend
```

---

## Issue 10.7 — Scenarios

Commands:

```text
create
addOverride
updateOverride
removeOverride
archive
evaluate
```

Scenario stores deltas, not cloned models.

### Commit

```text
feat(finance): add delta-based scenarios
```

---

## Issue 10.8 — Forecast/Scenario UI

Implement:

```text
Plan → Forecast
Plan → Scenarios
Available-to-Spend detail
goal probability/date
```

### Commit

```text
feat(web): add forecast and scenario experience
```

---

## Issue 10.9 — Forecast Validation Suite

Must prove:

```text
same seed → same output
P10 <= P50 <= P90
more variance widens interval
transfer conserves total cash
no safety-floor double counting
```

### Commit

```text
test(forecast): add deterministic probabilistic validation suite
```

---

# EPOCH 11 — Recommendations + Home Dashboard

## Issue 11.1 — Recommendation Model

Add:

```text
recommendations
```

Structured fields:

```text
observation
whyItMatters
goal links
evidence
actions
confidence
importance
status
```

### Commit

```text
feat(db): add recommendation model
```

---

## Issue 11.2 — Recommendation Workflow

Initial triggers:

```text
unusual spending
subscription increase
cashflow risk
goal delay
new recurring
large transaction
```

Deterministic finding first, AI framing second.

### Commit

```text
feat(ai): add validated recommendation workflow
```

---

## Issue 11.3 — Dashboard Persistence

Add:

```text
dashboards
dashboard_versions
dashboard_widgets
```

### Commit

```text
feat(db): add dashboard persistence
```

---

## Issue 11.4 — Home Dashboard

Default:

```text
Net Worth
Available to Spend
This Month
Top 3 Recommendations
Cashflow widget
Goal status
Ask anything about your money
```

### Commit

```text
feat(web): add personalized home dashboard
```

---

## Issue 11.5 — Customize Mode

Use dnd-kit.

Support:

```text
reorder
resize
remove
restore
version conflict
```

### Commit

```text
feat(web): add explicit dashboard customize mode
```

---

# EPOCH 12 — Deep Analysis

## Objective

Deliver durable comprehensive financial investigation.

## Issue 12.1 — Analysis Persistence

Add:

```text
analyses
analysis_findings
analysis_evidence_links
ai_workflow_runs
ai_workflow_steps
```

### Commit

```text
feat(db): add deep analysis persistence
```

---

## Issue 12.2 — Snapshot + Baseline

Create immutable cutoff and deterministic baseline:

```text
cashflow
spending trends
recurring
income
goals
forecast
```

### Commit

```text
feat(ai): add deep analysis baseline stage
```

---

## Issue 12.3 — Investigator Contract

Structured result:

```text
title
claim
importance
confidence
evidenceRefs
relatedEntities
followups
```

### Commit

```text
feat(ai): define deep analysis investigator contract
```

---

## Issue 12.4 — Parallel Investigators

Implement:

```text
spending
income
recurring
risk
goals
```

Each has bounded tools/budget.

### Commit

```text
feat(worker): run deep analysis investigators in parallel
```

---

## Issue 12.5 — Synthesis + Evidence Validation

Synthesis consumes structured findings.

Deterministically recompute arithmetic.

Drop/mark unsupported claims.

### Commit

```text
feat(ai): synthesize and validate deep analysis findings
```

---

## Issue 12.6 — Reviewer

Check:

```text
unsupported claims
contradictions
missing high-importance issue
recommendation alignment
tone
evidence coverage
```

### Commit

```text
feat(ai): add deep analysis reviewer
```

---

## Issue 12.7 — Deep Analysis UI

Implement:

```text
Run Deep Analysis
optional instruction
live durable progress
Stop
history
detail
```

### Commit

```text
feat(web): add deep analysis experience
```

---

## Epoch 12 Acceptance

Kill worker during investigator stage.

Restart workers.

Expected: workflow resumes from durable checkpoint rather than restarting from zero.

---

# EPOCH 13 — Artifact Runtime Security Boundary

## Objective

Prove secure code isolation before letting models generate artifacts.

## Issue 13.1 — Separate Renderer Site

Create separate deployable renderer with no finance secrets.

### Commit

```text
feat(artifacts): create isolated renderer application
```

---

## Issue 13.2 — MessageChannel Protocol

Implement:

```text
exact-origin handshake
session nonce
MessageChannel
schema validation
protocol version
```

### Commit

```text
feat(artifacts): add secure renderer bridge protocol
```

---

## Issue 13.3 — Restricted JS VM

Run generated JS in:

```text
Worker
QuickJS/WASM candidate
```

Expose no direct browser globals.

### Commit

```text
feat(artifacts): execute generated logic in restricted vm
```

---

## Issue 13.4 — Trusted UI Protocol

Primitives:

```text
text
metric
container/grid
table
button
input
slider
select
trusted chart
```

### Commit

```text
feat(artifacts): add trusted artifact ui protocol
```

---

## Issue 13.5 — Artifact Finance SDK

Read-only initial surface:

```text
analytics.cashflow
analytics.spendingByCategory
accounts.getBalances
goals.get
forecast.evaluate
```

Permission manifest enforced by host/backend.

### Commit

```text
feat(artifacts): expose scoped finance sdk
```

---

## Issue 13.6 — Sanitization + Quotas

Implement:

```text
HTML sanitization
CSS sanitization
strict CSP
Permissions Policy
CPU limit
memory limit
tool-call limit
result-size limit
render-node limit
state-size limit
```

### Commit

```text
security(artifacts): enforce artifact sandbox policy
```

---

## Issue 13.7 — Adversarial Escape Suite

Test attempts:

```text
fetch
XHR
WebSocket
navigation
parent DOM
window/document
cookies
localStorage
indexedDB
dynamic import
infinite loop
memory exhaustion
tool flood
permission escalation
forged messages
```

### Commit

```text
test(artifacts): add sandbox escape adversarial suite
```

---

# EPOCH 14 — Artifact Generation, Library, Editor

## Issue 14.1 — Artifact Persistence

Add:

```text
artifacts
artifact_versions
artifact_state
artifact_permissions
artifact_activity
```

Versions immutable.

### Commit

```text
feat(db): add persistent artifact model
```

---

## Issue 14.2 — Artifact Planner

Structured plan includes:

```text
purpose
data needs
permissions
layout
interactions
compact mode
```

### Commit

```text
feat(ai): add artifact planner capability
```

---

## Issue 14.3 — Artifact Builder

Generate only approved source/dependencies/SDK.

### Commit

```text
feat(ai): add artifact builder capability
```

---

## Issue 14.4 — Validation/Review/Fix Pipeline

```text
parse
permission validation
compile
sanitize
smoke test
review
bounded repair (max 2–3)
publish candidate
```

### Commit

```text
feat(worker): add artifact build review pipeline
```

---

## Issue 14.5 — AI Library

Tabs:

```text
Artifacts
Analyses
Conversations
```

### Commit

```text
feat(web): add ai library
```

---

## Issue 14.6 — Artifact Editor

Tabs:

```text
Preview
Code
Data
Activity
Versions
```

Direct code editing uses exact same validation/sandbox.

### Commit

```text
feat(web): add artifact editor and version history
```

---

## Issue 14.7 — Dashboard Pinning

Artifact supports:

```text
compact dashboard mode
full-screen mode
pin/move
```

### Commit

```text
feat(web): pin live artifacts to dashboard
```

---

# EPOCH 15 — Spending Plans + Conflicts

## Issue 15.1 — Spending Plan Persistence

Add/finalize:

```text
spending_plans
spending_plan_versions
spending_plan_lines
```

One active version per plan.

### Commit

```text
feat(db): add versioned spending plans
```

---

## Issue 15.2 — Plan Commands

Implement:

```text
create
createVersion
activateVersion
archive
```

### Commit

```text
feat(finance): add spending plan commands
```

---

## Issue 15.3 — Behavior vs Plan Forecast

Compute both trajectories.

Plan target is not assumed guaranteed behavior.

### Commit

```text
feat(forecast): compare behavior and planned trajectories
```

---

## Issue 15.4 — Plan Conflicts

Detect:

```text
GOALS_INCOMPATIBLE
SAFETY_BUFFER_BREACH
NEGATIVE_CASH
PLAN_TARGET_MISSED
GOAL_DATE_MISSED
OVERALLOCATED_CASH
```

### Commit

```text
feat(finance): add plan conflict detection
```

---

## Issue 15.5 — UI

Plan → Spending Plans.

AI may propose changes only through typed commands.

### Commit

```text
feat(web): add spending plans and conflict ux
```

---

# EPOCH 16 — Investments, Assets, Debt

## Issue 16.1 — Investment Model

Add/finalize:

```text
investment_accounts
instruments
holding_snapshots
```

### Commit

```text
feat(db): add investment holdings model
```

---

## Issue 16.2 — Manual/CSV Holdings Import

No live brokerage integration.

### Commit

```text
feat(finance): add manual investment import
```

---

## Issue 16.3 — Assets/Liabilities

Add:

```text
assets
asset_valuations
liabilities
liability_balance_snapshots
```

### Commit

```text
feat(db): add assets and liabilities model
```

---

## Issue 16.4 — Net Worth Integration

Include investments/assets/debts.

Available-to-Spend excludes investments by default.

### Commit

```text
feat(finance): integrate full net worth model
```

---

## Issue 16.5 — UI

Implement:

```text
Money → Investments
Money → Assets & Debt
```

### Commit

```text
feat(web): add investments and assets debt screens
```

---

# EPOCH 17 — Notifications, Scheduling, Proactivity

## Issue 17.1 — Notifications Persistence

Add `notifications`.

### Commit

```text
feat(db): add notifications
```

---

## Issue 17.2 — Schedule Dispatcher

Canonical schedule lives in PostgreSQL.

BullMQ scheduler tick finds due schedules.

### Commit

```text
feat(worker): dispatch due scheduled tasks
```

---

## Issue 17.3 — Missed-Run Policies

Implement:

```text
LATEST_ONLY
RUN_ONCE_AS_SOON_AS_AVAILABLE
SKIP_IF_MISSED
```

### Commit

```text
feat(worker): add scheduled task catchup policies
```

---

## Issue 17.4 — Notification Generation

Initial sources:

```text
Deep Analysis complete
import complete
forecast risk
goal risk
recurring price increase
artifact refresh
```

### Commit

```text
feat(worker): generate durable finance notifications
```

---

## Issue 17.5 — Notification Center

In-app V1.

Settings:

```text
notification categories
AI Proactivity Low/Balanced/High
```

### Commit

```text
feat(web): add notification center and proactivity settings
```

---

# EPOCH 18 — Export, Deletion, Security UX

## Issue 18.1 — Step-Up Authentication

Implement reusable server-side fresh-auth requirement.

### Commit

```text
security(auth): add sensitive-action step-up
```

---

## Issue 18.2 — Full Data Export

Background workflow creates:

```text
CSV
JSON
manifest
README
```

Private S3 object, short expiry.

### Commit

```text
feat(privacy): add full workspace export
```

---

## Issue 18.3 — Deletion Workflow

Implement:

```text
revoke access
revoke sessions
cancel jobs/schedules
purge tenant domain data
delete S3 objects
destroy encrypted credentials
remove processor/auth data as applicable
```

### Commit

```text
feat(privacy): add workspace deletion workflow
```

---

## Issue 18.4 — Deletion Tombstones

Keep minimal protected tombstone ledger so old backups cannot resurrect deleted users.

### Commit

```text
feat(privacy): add deletion tombstone enforcement
```

---

## Issue 18.5 — Privacy/Security UI

Settings includes:

```text
sessions
auth methods
export
delete
retention explanation
artifact permissions
```

### Commit

```text
feat(web): complete privacy and security settings
```

---

# EPOCH 19 — Observability, Backups, Disaster Recovery

## Issue 19.1 — Production Dashboards

Grafana dashboards for:

```text
API
Postgres
Redis/BullMQ
outbox
AI
forecast
artifacts
imports
security events
```

### Commit

```text
ops: add production observability dashboards
```

---

## Issue 19.2 — Alerts

Actionable alerts:

```text
5xx spike
latency breach
Postgres down
Redis down
outbox lag
interactive queue backlog
stalled jobs
AI provider failure/fallback spike
backup failure
KMS errors
```

### Commit

```text
ops: add production reliability alerts
```

---

## Issue 19.3 — Backup Automation

Enable/verify:

```text
Neon PITR
scheduled snapshots
daily direct pg_dump → encrypted S3
```

### Commit

```text
ops: automate layered database backups
```

---

## Issue 19.4 — Restore Drill

Restore to isolated environment and verify:

```text
schema
finance data
RLS
deletion tombstones
artifacts
AI metadata
```

Record real restore time.

### Commit

```text
ops: verify and document database restore procedure
```

---

## Issue 19.5 — Runbooks

Create:

```text
Postgres outage
Redis outage
AI provider outage
worker backlog
bad deploy
bad migration
backup restore
KMS issue
credential compromise
data deletion failure
```

### Commit

```text
docs(ops): add production incident runbooks
```

---

# EPOCH 20 — Security Hardening + External Review Gate

## Issue 20.1 — ASVS/API Review

Map implementation against:

```text
OWASP ASVS
OWASP API Security
NIST SSDF
```

Fix launch-critical gaps.

---

## Issue 20.2 — DAST

Run staging DAST.

Critical/high exploitable findings block launch.

---

## Issue 20.3 — Permanent Tenant Isolation Suite

Attempt:

```text
A reads B transaction
A updates B goal
AI crosses workspace
artifact crosses workspace
worker executes wrong workspace
bulk selection crosses workspace
export includes B
```

Expected: deny at multiple layers.

---

## Issue 20.4 — File Parser Adversarial Testing

Fuzz CSV/XLSX parser and all resource limits.

---

## Issue 20.5 — Artifact Sandbox Security Review

Run full escape suite in supported browsers.

---

## Issue 20.6 — Prompt-Injection / Tool-Abuse Review

Test untrusted:

```text
merchant descriptions
CSV cells
tool outputs
future-document-like payloads
```

No unauthorized canonical writes.

---

## Issue 20.7 — Privacy Compliance Pack

Complete:

```text
DPIA
RoPA/data map
processor inventory
international transfer map
retention registry
privacy notice
```

---

## Issue 20.8 — SBOM / Dependency Review

Generate production SBOM and review critical dependencies.

---

# EPOCH 21 — Closed Beta Gate

## Objective

Validate the complete V1 with production-shaped operation and telemetry.

## Required User Journey

```text
1. Sign up
2. Complete strong-auth setup
3. Import CSV/XLSX
4. Resolve uncertainty
5. See Home
6. Browse accounts/transactions/recurring
7. Correct categorization
8. Ask grounded AI
9. Run Deep Analysis
10. Create goal
11. Run forecast/scenario
12. Receive recommendations
13. Generate artifact
14. Pin artifact
15. Inspect AI activity/evidence
16. Export data
17. Delete test workspace
```

## Beta Metrics

Track:

```text
import success/failure
time to usable dashboard
classifier correction rate
AI unsupported-claim rate
tool errors
Deep Analysis completion
forecast errors/calibration diagnostics
artifact generation success
sandbox runtime failures
job retries/stalls
privacy workflow failures
support/security incidents
```

## Launch Blockers

Any of these blocks wider launch:

```text
cross-tenant access
data loss
wrong-money arithmetic
unbounded duplicate mutation
unrecoverable import corruption
high unsupported-claim rate in core finance answers
artifact sandbox escape
backup restore failure
privacy export/deletion failure
```

---

# 6. Recommended Issue Template

Every implementation issue derived from this document should use:

```markdown
# Objective

# Context / Architecture References

# Exact Scope

# Non-Goals

# Files / Modules Expected to Change

# Data Model / Migration

# API / Tool Contract

# Business Rules / Invariants

# Authorization / Security

# Failure / Retry Behavior

# Observability

# Tests Required

# Manual / Computer-Use Acceptance

# Definition of Done
```

---

# 7. AI Coding Agent Contract

When handing one issue to an implementation model, use this contract:

```text
You are implementing ONLY this issue.

Read:
- product specification
- technical architecture
- implementation issue

Do not invent alternate architecture.

Before changing code:
1. inspect relevant modules
2. inspect current tests
3. inspect current migrations/contracts
4. identify exact files to change

Implement in small coherent commits.

After implementation:
- run typecheck
- run relevant unit/integration tests
- run migration tests
- run Playwright/manual acceptance where relevant
- report architecture mismatches instead of silently working around them
```

Do not hand a coding model an entire epoch as one implementation prompt unless it is only planning the work.

---

# 8. Computer-Use Acceptance Checklist by Surface

## Authentication

```text
[ ] sign in
[ ] sign out
[ ] revoke sessions
[ ] second workspace/user isolation
[ ] CSRF rejection
```

## Import

```text
[ ] upload CSV
[ ] upload XLSX
[ ] column mapping
[ ] close/reopen during import
[ ] duplicate warning
[ ] import summary
```

## Money

```text
[ ] account overview
[ ] transaction filter/search
[ ] transaction detail
[ ] view original
[ ] edit category
[ ] undo
[ ] recurring
[ ] transfer
```

## Plan

```text
[ ] create goal
[ ] goal allocation
[ ] financial rule
[ ] financial model
[ ] forecast
[ ] Available to Spend
[ ] scenario
[ ] spending plan
```

## AI

```text
[ ] grounded question
[ ] evidence opens
[ ] Stop works
[ ] refresh/reconnect works
[ ] Deep Analysis
[ ] tool activity
```

## Artifacts

```text
[ ] generate
[ ] open full-screen
[ ] interact
[ ] edit with AI
[ ] edit code
[ ] revert version
[ ] pin dashboard
[ ] malicious artifact cannot escape
```

## Privacy

```text
[ ] export
[ ] export expires
[ ] deletion
[ ] restore fixture does not resurrect deleted workspace
```

---

# 9. Explicit MVP Non-Goals

Do not delay V1 for:

```text
live bank sync
mobile apps
household sharing
public artifact sharing
transaction splitting
real-time brokerage feeds
market-return forecasting
FX forecasting
money movement
subscription cancellation
investment trading
credit decisions
email/push delivery
self-hosting
local-first mode
full offline finance data
enterprise SSO
complex RBAC
Kafka
Temporal
microservices
vector database
data warehouse
separate read/write databases
multi-region active-active
deep-learning forecasting
```

Implementation agents should not add these “for future proofing.”

---

# 10. Post-MVP Dependency Notes

## Live Banking

Only after source/canonical model is proven:

```text
provider selection
consent/auth
encrypted provider tokens
sync cursors
added/modified/removed lifecycle
balance freshness
reauthentication
webhooks
reconciliation
provider outage UX
DPIA/security review
```

## Household Sharing

```text
workspace invitations
object-level visibility
shared goals
actor-aware audit
privacy boundaries
```

## Financial Documents

```text
PDF/document ingestion
quarantined extraction model
document evidence
prompt injection isolation
```

## External Financial Actions

A new risk tier requiring:

```text
strong step-up
provider idempotency/reconciliation
double-entry/internal ledger where relevant
transaction confirmation/signing UX
fraud/risk controls
legal/regulatory review
external penetration test
```

---

# 11. Dependency Graph

```text
E0 Foundation
 ↓
E1 Auth/RLS
 ↓
E2 Commands/Jobs
 ↓
E3 Import
 ↓
E4 Canonical Transactions
 ↓
E5 Corrections/Audit
 ↓
E6 Grounded AI ─────────────┐
 ↓                          │
E7 Normalization/Review     │
 ↓                          │
E8 Transfers/Recurring      │
 ↓                          │
E9 Planning Core            │
 ↓                          │
E10 Forecast/Scenarios      │
 ↓                          │
E11 Home/Recommendations    │
 ↓                          │
E12 Deep Analysis ──────────┤
                            │
E13 Artifact Runtime        │
 ↓                          │
E14 Artifact Generation ◄───┘
 ↓
E15 Spending Plans
E16 Investments/Assets/Debt
E17 Notifications
E18 Privacy Workflows
E19 Ops/DR
E20 Security Gate
E21 Closed Beta
```

---

# 12. Safe Parallelization

After Epoch 6, engineering can fan out when contracts are stable:

```text
Stream A:
  normalization
  transfer/recurring

Stream B:
  planning
  forecasting

Stream C:
  artifact sandbox

Stream D:
  dashboard/design-system refinements
```

Deep Analysis should wait until analytics/planning/forecast/job contracts are stable.

Artifact AI generation must wait until the artifact sandbox is proven.

---

# 13. Build Early Even Though It Feels Boring

These are deliberately early:

```text
RLS
idempotency
audit
outbox
durable jobs
exact-money utilities
evidence references
tenant isolation tests
```

Retrofitting them later is much riskier.

---

# 14. Do Not Overbuild Early

These deliberately wait until evidence demands them:

```text
Temporal
Kafka
microservices
enterprise authorization
offline sync
multi-region active-active
specialized search cluster
data warehouse
vector database
deep-learning forecasts
```

---

# 15. Epoch Completion Review

Before closing any epoch, perform an adversarial review across:

```text
correctness
security
tenant isolation
idempotency
failure/retry behavior
UX dead ends
accessibility
data loss
privacy
performance
observability
spec drift
```

If implementation reveals a genuine architecture problem, update the architecture before building dependent work.

---

# 16. Final Execution Principle

The product should become useful early and sophisticated incrementally:

```text
E0–E2
  reliable platform

E3–E6
  real finance app + grounded AI

E7–E10
  intelligent finance model + planning

E11–E14
  true AI-native workspace

E15–E18
  product completeness

E19–E21
  production readiness
```

Optimize implementation for:

```text
correctness
small deployable batches
clear contracts
observable behavior
safe failure
easy rollback
evidence
```

—not for the largest possible amount of code per epoch.
