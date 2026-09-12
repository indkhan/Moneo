# AI-Native Personal Finance Workspace — Implementation Epochs

**Status:** Execution specification  
**Architecture source of truth:** `personal_finance_technical_architecture_v11.md`  
**Product source of truth:** `ai_native_personal_finance_product_spec_v7.md`  
**Purpose:** Turn the approved product and technical architecture into a sequential implementation plan that can be executed by engineers or coding agents with minimal ambiguity.

**Handoff revision:** 2026-09-12. This document owns issue scope, execution order, dependencies, and release gates. The product document owns user-visible requirements; the architecture owns technical invariants and contracts. Architecture sections 490–534 are supporting design notes, not a second backlog. Resolve conflicting requirements in the owning document and update the coverage map here before dependent implementation.

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

Explicit issue dependencies override numeric order. Issue IDs remain stable when work moves earlier. Each issue must be expanded using section 6 before assignment: name an owner, cite exact product/architecture sections, specify inputs/outputs and error cases, and identify executable acceptance checks. A heading, table list, or suggested commit message alone is not a team-ready ticket. The engineering lead owns this readiness check; implementation owners supply evidence and a second reviewer signs off the epoch gate. No named staff assignments or delivery estimates are implied by this document.

Use synthetic data until the E18 privacy, E19 recovery, and E20 security gates pass. Early deployability means synthetic-data staging; permission to process real user financial data is a separate release gate.

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

## Issue 0.9 — Exact Money Foundation

### Scope

Implement once in `@moneo/shared` (single canonical copy). Issue 4.4 becomes
an integration check, not a second implementation:

```text
localized amount parser
minor-unit conversion
currency exponent
currency formatter
safe integer checks
exact JSON serialization
```

### Rules

```text
No authoritative floating-point money.
Negative input maps to explicit direction (credit/debit), never a signed amount.
Overflow beyond the safe integer range is rejected, never clamped or rounded.
Minor units serialize as decimal strings in JSON, never numbers.
```

### Tests

Verify before import code uses monetary values:

```text
EUR/JPY/BHD round-trips
localized separators
negative input mapped to explicit direction
overflow rejection
exact JSON serialization round-trip
```

### Commit

```text
feat(shared): add exact money foundation
```

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

## Issue 1.8 — Strong Authentication Enrollment and Recovery

**Depends on:** 1.3–1.7. **References:** architecture §§420–427, 474; product §81.10.

Implement passkey enrollment where the configured authentication domain supports it, with password + TOTP and recovery codes as the supported fallback. Use provider-backed enrollment/recovery, not a custom authentication system. A new user may navigate the empty shell during setup; importing financial data and accessing an active finance workspace require the server to verify strong-auth enrollment. Show enrollment status, recovery guidance, and a resumable setup flow. Provider unavailability must not silently downgrade the requirement.

**Acceptance:** fresh user cannot bypass setup via a direct import/API request; supported enrollment unlocks finance access; recovery and factor replacement require the provider's protected flow; expired/revoked sessions fail; unsupported passkey setup offers the TOTP fallback. Use synthetic identities to verify both paths. E18 adds fresh-auth checks for sensitive actions; enrollment alone is not step-up authentication.

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

## Issue 2.9 — API Contracts and Generated Client Bootstrap

**Depends on:** 2.2–2.3. **References:** architecture §§285–286, 336, 498.

Establish OpenAPI 3.1 contracts for `/api/v1`, RFC 9457 errors, decimal-string money/version fields, cursor envelopes, command metadata, and job submission/status. Generate the Orval client into a marked generated directory; consume it from the shell/job UI. Validate requests at the server boundary. Define a reproducible generation command and CI drift check; do not hand-maintain duplicate browser DTOs.

**Acceptance:** a fresh clone generates identical output; CI detects an uncommitted contract/client mismatch; malformed requests produce documented errors; browser integration uses the generated client. Every subsequent API issue extends this contract before consumers are implemented.

## Issue 2.10 — Change Propagation and Realtime Recovery

**Depends on:** 2.2, 2.5–2.9. **References:** product §2.4; architecture §§287, 298–305.

Define typed domain events, a shared query-invalidation map, authenticated SSE/polling fallback, reconnect/resync behavior, and version/cutoff metadata for derived results. Add each feature's recomputation consumer in the epoch that introduces it. Outbox publication must survive process failure; duplicate events must not duplicate effects. A UI must show stale/recomputing state until the authoritative query returns, never invent a recalculated financial total.

**Acceptance:** use a synthetic versioned entity to prove a command in one tab refreshes the other before finance tables exist; disconnect/reconnect recovers missed changes through authoritative refetch; duplicate/out-of-order events do not regress versions. E5 replaces the synthetic path with real transaction corrections; E10, E11, E12 and E14 extend it through their derived surfaces.

## Issue 2.11 — Resource Limits and Configuration

**Depends on:** 1.2, 2.3–2.6. **References:** architecture §§184–185, 377–378.

Define validated configuration for API/mutation rates, upload sizes/rows, worker concurrency and per-workspace quotas. Document initial numeric limits and failure policy in the ticket before coding. Add AI token/cost limits in E6 and artifact CPU/memory limits in E13. Rate-limit state must not evict durable queue transport data; follow the architecture's separate limiter policy.

**Acceptance:** two workspaces cannot exhaust each other's reserved execution capacity; excess work receives a structured bounded response; limiter failure follows the documented fail policy; quota rejection does not create a half-committed command/job.

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

Integrate and verify the shared utilities implemented in Issue 0.9; do not implement a second copy:

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

## Issue 4.9 — Historical FX and Transaction Valuation

**Depends on:** 0.4, 0.9, 2.9, 4.2–4.3. **References:** product §14; architecture §§11, 265, 535.

Implement `transaction_valuations`, workspace base-currency settings, historical rate ingestion/cache, exact conversion, provenance, and rebuildable valuation versions. Before implementation, record the chosen historical-rate source and supported currency/date coverage; verify its terms and operational limits. Do not silently substitute today's rate for an unavailable historical rate. Support an explicit user-supplied dated rate with provenance. Use the technical contract in §535 for rounding, missing-rate results and base-currency changes.

**Acceptance:** mixed EUR/JPY/BHD fixture produces independently calculated totals; native amounts survive base-currency changes unchanged; unavailable rates produce an incomplete result rather than a false total; retries do not duplicate valuations; AI evidence exposes rate date/source and calculation version. E6 analytics is blocked until this passes.

## Issue 4.10 — Balance Acquisition and Reconciliation

**Depends on:** 0.9, 2.2, 4.1, 4.3. **References:** architecture §§8, 233, 536.

Import trustworthy statement balances with their as-of/source cutoff and current/available meaning when present. For transaction-only files, offer an explicit manual current balance and as-of date; persist it as an audited snapshot. Implement `accounts.recordBalance` with idempotency/version checks, source provenance, and a reconciliation preview. Define whether transactions are already included before rolling a snapshot forward. Missing balance is unknown, not zero or the sum of imported history.

**Acceptance:** identical transaction histories with different opening balances produce different correct current balances; reimport/retry does not double-apply transactions; conflicting snapshots require resolution; absent/unreconciled balances mark aggregate/forecast coverage incomplete. E10 cannot display an actionable Available-to-Spend number for incomplete required balance coverage.

## Issue 4.11 — Overlapping Import Matching and Resolution

**Depends on:** 3.6, 3.8, 4.2–4.3. **References:** product §6.2; architecture §§9–10, 537.

Implement trusted external-identity matching and conservative matching for overlapping CSV/XLSX imports. File hashes remain only a duplicate-file signal. Persist match decisions/provenance and unresolved candidates. Ambiguous candidates remain staged outside accepted canonical totals until the user chooses link-to-existing or keep-as-distinct through typed audited commands; E7 exposes the same resolution in Review. The import summary must distinguish accepted, matched, pending-review and rejected rows.

**Acceptance:** August followed by August–September adds only confidently new rows; retrying either import has one effect; two legitimate identical purchases remain distinct; ambiguous matches are visible and resolvable; linking preserves prior canonical corrections and both source observations. No fuzzy-field uniqueness constraint may discard a row.

## Issue 4.12 — Manual Accounts and Cash Transactions

**Depends on:** 2.2, 2.9, 4.1–4.4, 4.10. **References:** product §§15, 70.1, 78.5; architecture §536.

Implement `accounts.createManual` and `transactions.createManual` with exact money, account ownership, date/direction validation, idempotency, audit and version handling. Provide account/transaction entry UI and an explicit balance-effect contract: a transaction already included in a recorded balance must not be applied again. Preserve manual provenance without fabricating an imported observation. E5 adds correction/undo integration; E9.7 exposes these commands to AI only on explicit user intent.

**Acceptance:** create a cash wallet and a €15 purchase; retry yields one transaction; unauthorized account selection fails; future/older transactions respect snapshot cutoff rules; balances and analytics update consistently.

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

## Issue 5.7 — Complete Transaction Workspace

**Depends on:** 2.9–2.10, 4.6–4.8, 5.3–5.5. **References:** product §§78.2–78.4; architecture §§69–70, 307–311.

Add bulk category/tag commands using the architecture's frozen-selection contract, including explicit IDs and all-matching-query selection. Persist saved views and configurable column state; extend filters for category, tags, merchant and review status as their domains become available. Provide preview/count, progress, conflict results and safe undo where applicable. E6.11 adds natural-language conversion into this same typed filter contract.

**Acceptance:** saved views survive reload; bulk operations never touch another workspace or rows added after selection; retry applies once; stale rows return explicit conflicts without silently overwriting them; keyboard selection and column controls work. Test selection larger than the loaded page.

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

## Issue 6.10 — AI Data-Access Exclusions

**Depends on:** 1.2, 2.2, 2.9, 4.9–4.12. **Must precede:** 6.4–6.8. **References:** product §81.9; architecture §538.

Implement account and asset/liability AI-access policy, policy versioning, settings controls and server-side enforcement. Assets/liabilities adopt the contract in E16. Apply exclusions before deriving aggregates, evidence, prompts or cached context; the same policy governs all AI capabilities and generated-artifact Finance SDK reads. Product scopes cannot be widened by prompts or Custom AI. Retain excluded objects in ordinary finance/net-worth views according to their separate finance settings.

**Acceptance:** an excluded account cannot influence an AI aggregate, tool result, evidence lookup or resumed conversation context; a direct object-ID probe fails without revealing content; changing policy invalidates cached/queued context and stops affected runs before further disclosure. Repeat these tests in E12/E14/E16. Explain that previously transmitted provider data cannot be recalled by a new exclusion.

## Issue 6.11 — Persistent AI Panel and Global Command Search

**Depends on:** 5.7, 6.4–6.10. **References:** product §§56, 82.1–82.2; architecture §§322–323.

Wire the existing panel mount to the same durable conversations/runs as AI Chat. Preserve the active thread across navigation and provide visible, removable/pinned page/object context. Add a keyboard-accessible command palette for authorized objects, navigation and supported actions. Natural-language transaction filtering produces a validated, visible typed filter; it does not create a second agent or bypass server search. Add new object types as later epochs deliver them.

**Acceptance:** navigation preserves a running conversation; changing/removing context changes the next request; hidden/excluded objects never enter context; palette search is tenant-safe; natural-language and equivalent manual filters return the same rows; focus returns correctly on close.

## Issue 6.12 — Included/Custom AI Configuration and Credentials

**Depends on:** 1.8, 6.1–6.3, 6.6, 6.10. **References:** product §§81.5–81.9; architecture §§373–374, 539.

Implement Settings → AI modes, supported provider credential connect/test/rotate/revoke, per-capability model mapping, prompt viewing/editing/restoration, usage and data-access pages. Use server-side envelope encryption and an explicit endpoint/model allowlist. Included prompts are read-only; Custom prompts cannot change scopes, exclusions, budgets or other product safeguards. Implement the fresh-auth helper needed for credential changes now; E18.1 reuses it. Resolve the initial supported provider/model matrix and privacy policy in the ticket before integration.

**Acceptance:** no secret appears in browser responses, logs, model context or stored plaintext; revocation prevents subsequent calls; queued runs recheck credential/policy status; unsupported endpoints/models fail safely; prompt restoration works; usage shows actual resolved provider/model and cost when available; provider failures never silently use a different credential/billing mode. Cover both Included and Custom paths in the E6 eval harness.

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

## Issue 7.6 — Merchant Detail and Category Management

**Depends on:** 5.1–5.7, 7.2–7.5. **References:** product §§12, 78.9–78.11.

Build merchant detail with associated transactions, trends, recurring links and contextual AI; add custom category/tag create/rename/archive management and inspectable learned normalization rules. Reuse typed correction commands and E2.10 propagation. **Acceptance:** changing a merchant/category updates lists and analytics without modifying raw observations; archived categories retain historical meaning; drill-down and AI context obey authorization; ambiguous duplicate resolution reuses 4.11 rather than creating another matcher.

## Issue 7.7 — AI-Assisted Import Mapping and History

**Depends on:** 3.5–3.7, 4.11, 6.6, 6.10. **References:** product §§5–8, 70.1, 82.4.

Add AI-assisted format/account/column detection using bounded untrusted previews, schema-validated mapping proposals and the existing manual correction flow. Users confirm the preview before canonical import. Existing-account AI exclusions apply to source previews; for an unknown destination, obtain the user's destination/data-access choice before sending source content. Add import history, row disposition summaries, original-source access and resume/retry navigation. **Acceptance:** injected cells cannot trigger tools or writes; unsupported layouts recover via manual mapping; preview errors are caught before import; completed/failed/cancelled imports remain inspectable; overlapping imports use 4.11 semantics.

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

Use the commands delivered by 9.8. Also expose 4.12 manual account/transaction commands under this same explicit-intent policy; a request for analysis alone never authorizes creating a cash transaction. Command implementation precedes its AI adapter regardless of preserved issue numbering.

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

## Issue 9.8 — Planning Commands and Model Lifecycle

**Depends on:** 9.1–9.5, 2.10. **References:** product §§18–20, 24, 79.1–79.3, 79.8–79.11. Implement commands before the 9.6 UI and 9.7 AI adapters.

Complete goal create/update/archive, virtual allocation add/update/remove and contribution-plan commands, plus rule/assumption create/update/disable/supersede. Expose inspectable sources/confidence and resolution of conflicting assumptions. E9.5 resolves absent spending plans as an explicit empty optional input until E15, not a missing-table read. Wire UI and explicit-intent AI adapters through the same commands. **Acceptance:** allocations do not move money or double-count reserves; stale writes conflict; user-confirmed assumptions outrank inference; each mutation invalidates derived model state; account rules and AI preferences remain distinct.

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

## Issue 11.6 — Complete Dashboard and Recommendation Interactions

**Depends on:** 6.11, 10.8, 11.1–11.5. **References:** product §§51–55, 77.1–77.12.

Add multiple dashboards/default selection, dashboard-wide period, trusted widget add/configure/duplicate/move/remove, metric evidence drill-down and recommendation see-all/dismiss/material-change behavior. Dashboard AI edits use typed versioned commands and undo; asking about a dashboard does not implicitly change it. Add the empty/running-first-analysis presentation now; E12 populates it. E14 supplies artifact entries in the same add/menu flows. **Acceptance:** two-tab layout edits conflict safely; period changes reach applicable widgets; refresh preserves layouts/dismissals; recommendations reappear only under documented material-change rules; Home's AI entry uses the persistent thread. Record the changed condition/reason for resurfacing a dismissed recommendation.

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

## Issue 12.8 — First-Use Analysis and Durable Activity History

**Depends on:** 7.7, 11.6, 12.1–12.7. **References:** product §§5, 31–34, 64, 80.3, 80.7.

Connect the first successful usable import to an idempotent initial-analysis trigger behind the onboarding flag. Imports with unresolved required inputs show actionable setup/review rather than fabricate complete analysis. Persist saved analysis sessions and a searchable/filterable AI activity view with run status, supported tool summaries, evidence, actual model/cost metadata and Stop/retry. No hidden chain-of-thought is stored. **Acceptance:** duplicate import completion emits one initial run; Home stays useful during analysis; refresh/reconnect restores progress; cancellation persists; invalidated/excluded inputs cannot leak through historical context; an analysis failure leaves imported finance data usable.

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

## Issue 14.8 — Artifact Lifecycle Completion

**Depends on:** 13.1–13.7, 14.1–14.7, 6.10, 2.10. **References:** product §§38–50, 70.6, 82.5.

Implement live-data invalidation, versioned persistent state, conversational edits, embedded AI through bounded host-mediated capabilities, and multiple artifact outputs from an analysis when justified. Provide starter templates through the same validation pipeline. Add PDF/image export from the trusted render output with a visible data cutoff and no executable/private credentials in the exported file. Exports obey current data access and do not grant public backend access. Canonical write requests, if exposed by an artifact, require a host-visible explicit action and the normal typed command policy; generated code cannot grant itself a write scope. E17 owns scheduled AI interpretation refresh.

**Acceptance:** state survives reopen without crossing versions/workspaces; source changes refresh eligible data; exclusion changes invalidate displayed/cached artifact data; embedded AI obeys quotas/Stop; code/AI edits produce immutable validated versions and safe revert; exported PDF/image matches the visible snapshot; artifact permission escalation is rejected.

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

## Issue 17.6 — Scheduled Artifact Refresh and Summary Workflows

**Depends on:** 12.8, 14.8, 17.1–17.5. **References:** product §§30, 49, 81.4, 82.3.

Expose enable/disable/frequency controls for supported scheduled artifact interpretation and weekly summaries. Ordinary live data refresh remains independent of AI scheduling. Each due run rechecks access policy, credentials, quotas and cancellation; schedules persist in PostgreSQL with explicit timezone/DST/missed-run semantics. **Acceptance:** duplicate scheduler ticks create one business run; disabled schedules stay disabled after restart; a missed-run fixture follows its policy; exclusions/revoked credentials prevent disclosure; users can disable non-critical categories and navigate notifications to the relevant object.

---

# EPOCH 18 — Export, Deletion, Security UX

## Issue 18.1 — Step-Up Authentication

Implement reusable server-side fresh-auth requirement.

Reuse and extend the helper delivered in 6.12; do not create a second fresh-auth implementation. Cover export, deletion, credential/security changes and the architecture's sensitive actions. Strong-factor enrollment in 1.8 does not replace checking authentication freshness.

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

## Issue 18.6 — Settings and Safe Maintenance Completion

**Depends on:** 4.9, 6.12, 7.6–7.7, 9.8, 11.6, 14.8, 17.5, 18.1–18.5. **References:** product §§81.1–81.13.

Complete General (name, locale/timezone, formatting, week start, default dashboard/horizon), Data & Imports, Appearance and supported Advanced settings. Link existing rules, AI configuration/preferences, notification, security and export controls rather than duplicating services. Include light/dark/system and comfortable/compact density. Offer authorized, audited maintenance jobs for rebuilding derived analytics/re-running categorization while preserving user corrections. Optional examples such as raw-ID display or grid-size customization are not new release blockers unless selected in the ticket.

**Acceptance:** settings persist across sessions; changing base currency follows 4.9; timezone/date rendering remains consistent; rebuild/reclassification retries preserve canonical corrections and audit; exports contain the documented manifest and supported domains; deletion cancels schedules and prevents later regeneration. Do not expose a user restore button backed only by an operator disaster-recovery procedure: V1 provides export and operator-managed recovery; workspace self-service restore is deferred explicitly in the product clarification.

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

The diagram is a high-level progression only. The dependency table in section 17 and explicit issue prerequisites are authoritative; do not interpret every vertical arrow as a requirement to finish unrelated product breadth first.

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

Apply section 17: planning schemas/UI may proceed in parallel, but the complete model/forecast waits for accepted recurring/transfer contracts. Artifact sandbox work can begin after E2 as a synthetic-data security spike; Finance SDK integration waits for E10. No stream can close its epoch without its required inputs and exit checks.

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

---

# 17. Authoritative Dependencies and Epoch Exit Gates

An epoch is complete only when its issues, relevant global Definition of Done, and the row below pass with recorded evidence. These gates supplement the earlier manual checks. Implement commands/contracts before their UI adapters even if a preserved issue ID appears later. Parallel work may use agreed synthetic fixtures; it cannot claim integration completion against mocks.

| Epoch | Prerequisites to close | Required executable/manual exit evidence |
|---|---|---|
| E0 | None; 0.9 precedes import money parsing | Fresh-clone install/build/migrations succeed; exact-money fixtures pass; web/worker deploy to synthetic staging; trace and version endpoint verified. |
| E1 | E0 | Two-user tenant isolation; server-enforced strong-auth setup and recovery; CSRF rejection and session revocation pass. |
| E2 | E1 | Generated contract/client drift check; duplicate command/outbox delivery and worker crash produce one business effect; cross-tab reconnect and quota failure tests pass. |
| E3 | E2, 0.9 | CSV/XLSX preview/manual mapping, malicious-file bounds, cancellation and retry fixtures pass; raw observations survive retries without silent row loss. |
| E4 | E3; 4.9–4.12 before finance consumers | Mixed-currency/missing-rate, balance cutoff, overlap/multiplicity and manual-cash fixtures pass; incomplete data is visibly incomplete; large-list pagination is deterministic. |
| E5 | E4; commands before drawer/bulk adapters | Stale single/bulk writes reject safely; frozen selection excludes later rows; undo preserves newer edits; saved views and corrections survive reload. |
| E6 | E5; 6.10 before all AI finance reads; 6.12 before Custom mode | Gold answers match deterministic values/evidence; prompt injection/excluded sentinels never leak; Stop/reconnect, panel/palette and Included/Custom settings work; secret/log checks pass. |
| E7 | E6 | Mapping proposals can be corrected; injected cells cannot act; review resolutions preserve multiplicity; merchant/category edits propagate; import history reconciles dispositions. |
| E8 | E7 | Matched transfers do not become income/spend and conserve eligible cash; recurring detection handles missed/changed payments; events can be corrected with evidence and undo. |
| E9 | E8 for resolved model; schemas may start after E6 | Goal/allocation/rule/assumption commands and UI pass conflict/undo tests; user-confirmed inputs win; virtual allocations do not move or double-count cash; absent spending plans resolve explicitly empty. |
| E10 | E9, 4.9–4.10, 2.10 | Reproducible forecast, FX/balance completeness, safety-floor and transfer fixtures pass; rolling-origin baseline comparison and interval coverage are recorded; scenario deltas do not mutate base state. |
| E11 | E10 | Home metrics reconcile to evidence; multiple dashboards/period/widget controls persist; layout conflicts/undo and recommendation dismiss/resurface tests pass; first-analysis placeholder works. |
| E12 | E11, 7.7, 6.10 | Duplicate initial-import trigger creates one analysis; fan-out crash/retry and cancellation recover; numeric evidence checks pass; excluded data stays excluded; saved analysis/activity reconnects. |
| E13 | E2 for isolated spike; E10 and 6.10 for Finance SDK completion | Supported-browser escape/quota suite passes, including CPU/memory/tool floods; revoked/excluded data access fails; no generated code gains browser/network authority. |
| E14 | E12, E13 | Generate/edit/revert/pin/live-refresh and state persistence pass; embedded AI obeys policy; PDF/image exports match the authorized snapshot; hostile generated code fails the pipeline. |
| E15 | E10, E11 | Exactly one active plan version; behavior-vs-plan comparison and each conflict type have fixtures; activating a plan updates the model/forecast without double-counting spending. |
| E16 | E4, E9–E10, 6.10 | Holdings/asset/debt entry and valuation reconcile net worth; investment cash is not spendable by default; asset exclusions pass the AI sentinel suite. |
| E17 | E12, E14 | Concurrent ticks, timezone/DST, missed runs and cancellation pass; disabled categories stay silent; scheduled AI revalidates policy/credentials; notification links resolve authorized objects. |
| E18 | E15–E17 and existing credential fresh-auth helper | All required settings persist; export manifest reconciles domain counts; expiry/auth checks pass; deletion cancels work/purges storage; tombstones prevent resurrection. |
| E19 | E18 | Restore to isolation succeeds including object references/tombstones; measured restore time and recovery point meet architecture §393 targets; alert delivery and incident runbooks exercised. |
| E20 | E19 | Tenant/parser/artifact/prompt-injection suites pass; no unresolved exploitable critical/high findings; privacy/data-flow review completed; independent-review decision recorded under architecture §521. |
| E21 | E20 and every required coverage-map row | Full fresh-user journey, manual/multi-currency/overlap paths and both AI modes pass; export/delete/restore drill evidence exists; all release blockers below are clear. |

For E10 backtesting, specify dataset eligibility, baseline and numeric calibration tolerances in Issue 10.9 before implementation; measure on held-out rolling-origin windows, not training data. A deterministic fallback with visible low confidence is required when data is insufficient. Quantile ordering alone is not forecast validation.

For release: zero known cross-tenant accesses, wrong-money results on deterministic fixtures, duplicate business effects, secret/excluded-data disclosures, sandbox escapes or failed deletion/restore checks. The versioned core AI gold suite must have zero unsupported material numeric claims; report its size and coverage rather than treating a small suite as a production guarantee. Beta production rates are monitored separately with an owner and intervention thresholds agreed before admission. A failed gate is not waived by a successful happy-path demo.

# 18. V1 Requirement Coverage and Team Ownership

Each row maps a product section to accountable implementation issues and the epoch that verifies it. Section ranges cover all subsections in that range. The ticket owner must copy the actual requirement bullets, including cross-references, into its acceptance checklist; a map row alone is not evidence of implementation. Product examples labelled optional/suggested remain optional unless the ticket explicitly selects them. Add any newly accepted requirement here in the same change as the product edit.

| Product requirement | Owning issue(s) | Integration gate |
|---|---|---|
| §§5–8, 70.1: first use, file ingestion, raw data, import history | 3.1–3.8, 4.11, 7.7, 12.8 | E12 |
| §§6.3, 21: transfers and recurring | 8.1–8.4, 8.6 | E8 |
| §§9–12, 16–17, 70.2: transaction model, classification, categories/tags, review/audit/undo | 4.2–4.8, 5.1–5.7, 7.1–7.6 | E7 |
| §§13, 18–20: events, financial memory/rules/model | 8.5–8.6, 9.2–9.8 | E9 |
| §§14–15: multi-currency, balances and manual/cash entry | 0.9, 4.9–4.12 | E4 |
| §§22–26, 70.4: forecast, metrics, goals, plans, scenarios | 9.1–9.8, 10.1–10.9, 15.1–15.5 | E15 |
| §§27–30: recommendations/tone/actionability/notifications | 9.4, 11.1–11.2, 11.6, 17.1–17.6 | E17 |
| §§31–34, 62–65, 70.3: analysis, saved sessions, capabilities, activity/Stop | 6.1–6.12, 12.1–12.8 | E12 |
| §§35–48, 70.6: artifact decision/build/runtime/edit/state/templates/embedded AI | 13.1–13.7, 14.1–14.8 | E14 |
| §§49–50: scheduled artifact AI and PDF/image export | 14.8, 17.6 | E17 |
| §§51–55, 70.5: dashboard system and multiple dashboards | 11.3–11.6, 14.7 | E14 |
| §§56–57: global search and contextual object pages | 4.7–4.8, 6.11, 7.6, 8.6, 9.6, 10.8, 16.5 | E16 |
| §§61, 70.7: Included/Custom modes and prompt controls | 6.12 | E6 |
| §§66–69: privacy/cloud/desktop and financial account types | 0.1–0.9, 1.1–1.8, 4.1, 16.1–16.5, 18.1–20.8 | E20 |
| §77.1–77.5: Home metrics, period, customize/add, dashboard selection | 11.3–11.6 | E11 |
| §77.6–77.12: first-analysis Home, recommendations, AI edits/entry, menus, summaries/hierarchy | 11.6, 12.8, 14.7 | E14 |
| §78.1–78.5: Money overview/table/saved views/detail/accounts | 4.7–4.12, 5.7, 6.11 | E6 |
| §78.6: recurring detail/actions | 8.3–8.6 | E8 |
| §78.7–78.8: investments/assets/debt | 16.1–16.5 | E16 |
| §78.9–78.12: Review, merchants, Money AI and UX principles | 7.1–7.6, 6.11, 8.6 | E8 |
| §79.1–79.3: Plan overview/goals/allocations | 9.1, 9.6, 9.8 | E9 |
| §79.4–79.5: spending plans/planned-vs-actual | 15.1–15.5 | E15 |
| §79.6–79.7: scenarios/forecast | 10.1–10.9 | E10 |
| §79.8–79.11: model/conflicts/AI/UX | 9.5–9.8, 10.8, 15.4–15.5 | E15 |
| §80.1–80.2: chat and inline tool activity | 6.8, 6.11 | E6 |
| §80.3: Deep Analysis area | 12.1–12.8 | E12 |
| §80.4–80.5: library and in-chat artifact creation | 14.2–14.8 | E14 |
| §80.6–80.9: evidence/activity/configuration placement/UX | 6.7–6.12, 12.8 | E12 |
| §81.1–81.2: General and Data & Imports | 4.9–4.10, 7.7, 18.2, 18.6 | E18 |
| §81.3–81.4: financial rules and notifications | 9.2, 9.6, 9.8, 17.5–17.6 | E17 |
| §81.5–81.8: AI modes/models/prompts/usage | 6.12 | E6 |
| §81.9: AI data access | 6.10, 12.8, 14.8, 16.3–16.5 | E16 |
| §81.10: privacy/security | 1.7–1.8, 6.12, 18.1–18.5 | E18 |
| §81.11–81.12: Appearance and supported Advanced controls | 18.6 | E18 |
| §81.13: AI preferences versus financial rules | 9.4, 9.6, 18.6 | E18 |
| §82.1–82.2: persistent panel and command palette | 6.11 | E6 |
| §82.3: notification center | 17.4–17.6 | E17 |
| §82.4: import workflow | 3.1–3.8, 4.10–4.11, 7.7 | E7 |
| §82.5: artifact editor | 14.6–14.8 | E14 |
| §82.6: shared background jobs | 2.4–2.8, 2.10–2.11 | E2 |
| §82.7–82.8: evidence links and shared interaction principles | 2.9–2.10, 6.7, all UI issues' global DoD | E21 |

Navigation sections 3–4 and 58–60 are verified through the corresponding locked surface rows above. Product §§71–76 retain scope boundaries and cross-surface example journeys; verify the required journeys in E21 without promoting explicitly later/optional examples into V1. Every locked subsection in §§77–82 is assigned above.

# 19. Issue Readiness and Handoff Checklist

Before assigning any issue, its owner and reviewer must record:

1. Product requirement bullets and exact architecture sections, linked to a coverage-map row.
2. Prerequisite issues and their passing evidence; any temporary synthetic contract and the later integration gate.
3. Exact domain/API/tool inputs, outputs, error codes, authorization and idempotency/version behavior. Specify decimal/string/date semantics where applicable.
4. Schema/migration/index/tenant-policy changes and data backfill/rollback or forward-recovery strategy. No speculative tables for later features.
5. Supported cases, non-goals, resource limits, failure/retry/cancellation and data-completeness behavior.
6. Small, named acceptance fixtures and expected results, integration path, accessibility checks and operational signals. Numeric thresholds must be chosen before implementation, not after seeing results.
7. Files/packages expected to change after inspecting the implemented repo, named owner/reviewer and an estimate made by the team. Do not invent concrete file paths before the foundation exists.

Then implement one issue in small deployable changes. Record actual checks, outcomes and limitations against the issue; update the coverage map when scope changes. Do not describe this planning document as a completed implementation or claim that a feature is verified because its task exists.

The first team assignment is E0: expand 0.1–0.9 into tickets, select/pin compatible runtime/dependency versions and verify external service capabilities against current official documentation. Provider selection, rate coverage, authentication-domain support and hosting limits are implementation-time verification gates, not facts certified by this document review.
