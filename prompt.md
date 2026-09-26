# Mission

You are working inside an existing Next.js/TypeScript codebase for an AI-native personal finance workspace.

The basic project foundation already exists:
- Next.js / React / TypeScript
- Supabase project connection
- basic database connection/configuration
- existing repository structure and dependencies may already exist

However, the actual product database schema, Supabase Storage setup, and most product functionality described below have **not** been implemented yet.

Your job is to take the existing repository and implement the complete functional product described in this prompt from the current foundation through the end-to-end product loop.

Do not rebuild the foundation unnecessarily.

---

# Primary Goal

At the end of this implementation, the following complete journey should work:

```text
Sign in
↓
Upload CSV/XLSX financial data
↓
AI understands the file structure
↓
User sees AI's proposed interpretation
↓
Continue / Correct / Cancel
↓
Transactions are imported safely
↓
Accounts, merchants, categories, recurring items, transfers, etc. are created
↓
Home immediately shows reliable financial information
↓
Deep Financial Analysis runs in the background
↓
User can continue using the website
↓
AI can answer grounded questions using finance tools
↓
User can create goals / scenarios / plans
↓
Forecasting works
↓
AI can generate a useful interactive financial artifact
↓
Artifact can be saved and pinned to Home
↓
User imports newer financial data
↓
Dashboard, forecasts and live artifacts update correctly
```

This complete loop matters more than polishing isolated screens.

---

# Engineering Philosophy

Build this in the **simplest clean way that correctly satisfies the product**.

Priorities:

1. correctness
2. maintainability
3. readability
4. simple architecture
5. good UX
6. testability
7. performance where actually needed

Avoid clever abstractions and speculative infrastructure.

Do NOT introduce unless absolutely necessary:

- Python backend
- microservices
- Redis
- BullMQ
- Trigger.dev
- Inngest
- separate worker deployment
- vector database
- Kafka
- event sourcing
- generic CRUD frameworks
- heavy agent frameworks
- unnecessary global state libraries
- unnecessary abstraction layers

Keep this primarily **one TypeScript codebase**.

Before implementing a new dependency, first check whether the existing stack can solve the problem cleanly.

Follow the existing repository's conventions wherever they are reasonable.

Do not refactor unrelated working code merely because you would personally structure it differently.

---

# Agreed Stack

Use:

```text
Next.js App Router
React
TypeScript

Vercel
Vercel Workflows

Supabase PostgreSQL
Supabase Auth
Supabase Storage

Drizzle ORM
Zod

OpenRouter
Vercel AI SDK

shadcn/ui
Tailwind CSS

TanStack Query
TanStack Table

Apache ECharts

Papa Parse
ExcelJS

CodeMirror

Vitest
Playwright
```

Use React state/context for ordinary frontend state.

Do not add Zustand unless there is a demonstrated cross-route UI-state problem that cannot remain clean with React state/context.

Use OpenRouter **free models only** during development.

There must be no automatic paid-model fallback.

---

# Work Autonomously

Inspect the existing repository thoroughly before making changes.

Understand:

- current routes
- existing Supabase setup
- environment handling
- auth implementation
- current DB utilities
- UI system
- coding conventions
- existing tests
- existing packages
- existing migrations

Then implement the product incrementally.

Do not repeatedly stop to ask questions.

When something minor is ambiguous:
- choose the simplest sensible implementation,
- document the assumption,
- continue.

Only treat something as blocked when it genuinely cannot be implemented without information or credentials unavailable in the repository.

Do not pretend an integration works if it could not actually be tested.

---

# 1. Supabase Foundation

Supabase is connected, but assume the required product tables and Storage structure do not yet exist.

Create proper reviewed migrations using Drizzle.

Do not create every imaginable future table upfront. Create the tables needed by the functionality in this prompt.

## Identity and tenancy

Use Supabase Auth.

Create application-level workspace ownership from day one.

Conceptually:

```text
auth.users
    ↓
workspace
    ↓
all financial/product data
```

Every user starts with one private workspace.

All user-owned product records must be workspace scoped.

Use Supabase/Postgres Row Level Security appropriately.

Never trust a `workspaceId` supplied by AI or the browser as authorization.

Server code determines the authenticated user's accessible workspace.

---

# 2. Financial Data Model

Implement a clean schema supporting at least:

## Imports / source evidence

- data sources
- imports
- source accounts
- source transactions / observations
- imported original data reference

Preserve what the uploaded source originally said.

Do not silently overwrite source evidence when the user later corrects the interpreted transaction.

## Canonical financial records

- accounts
- account-source relationships
- balance snapshots
- transactions
- transaction-source relationships
- merchants/counterparties
- categories
- tags
- transaction tags
- transfer relationships
- refunds/related transactions
- recurring series
- recurring-series transaction relationships
- financial events

## Planning

- goals
- goal allocations
- financial assumptions
- financial rules
- spending plans where needed
- scenarios
- scenario overrides
- forecast runs/results

## Product systems

- conversations
- messages
- AI runs/activity
- background jobs
- saved analyses
- notifications
- dashboards
- dashboard items
- artifacts
- artifact versions
- artifact state

Use normalized relational columns for important financial concepts.

Use JSONB only where flexible metadata is genuinely appropriate.

---

# 3. Exact Financial Data

Money must not use JavaScript floating-point arithmetic as authoritative financial state.

Use exact monetary representation.

For fiat currencies, prefer:

```text
amount_minor
currency_code
```

Example:

```text
€31.42
→ 3142 EUR
```

Use BigInt/exact arithmetic internally where appropriate.

Preserve original currency.

Never rewrite the original amount merely because the user's display currency changes.

---

# 4. CSV / XLSX Import Experience

This is one of the highest-priority features.

Support:
- CSV
- XLSX
- multiple uploaded files
- multiple accounts

Use Papa Parse and ExcelJS.

## UX

The flow must be:

```text
Upload
↓
Inspect file
↓
AI proposes interpretation
↓
Preview
↓
Continue / Correct / Cancel
↓
Background import
```

Do NOT begin with a manual mapping questionnaire.

### AI mapping

Analyze:
- institution if inferable
- account
- date columns
- descriptions
- merchant fields
- amount
- debit/credit semantics
- currency
- balance columns
- useful metadata

Use AI to propose a structured mapping.

AI does not directly write financial records.

Its mapping output must:
1. follow a strict schema,
2. pass application validation,
3. then be shown to the user.

### Preview

Show an understandable preview, not merely technical column names.

Include:
- proposed account
- currency
- detected date range
- example mapped transactions
- incoming/outgoing values

Allow:

```text
Continue
Correct
Cancel
```

Manual mapping remains a fallback.

---

# 5. Import Safety

Handle overlapping imports correctly.

Example:

```text
August.csv
then later
August-September.csv
```

Do not duplicate August transactions.

But also do NOT assume:

```text
same date + amount + description
```

always means duplicate.

Two legitimate purchases can be identical.

Ambiguous matches must go to Review instead of corrupting accepted totals.

Import processing must be retry-safe.

Re-importing or retrying must not:
- duplicate transactions
- erase previous user corrections
- generate repeated canonical effects

Keep import history.

Show:
- total rows
- new
- matched existing
- pending review
- rejected/errors

Support safe Undo Import where possible, with an impact preview.

---

# 6. Accounts and Balances

An account represents the user's real financial account, not an uploaded file.

CSV imports now and bank connections later must attach to the same account model.

Support:
- checking
- savings
- cash/manual account
- credit
- investment
- wallet
- other

Balance snapshots are separate from transactions.

Do not calculate current account balance simply as:

```text
sum(all imported transactions)
```

because imports may contain only partial history.

Allow:
- balance from file where reliable
- manual balance entry
- balance `as of` date

Show balance provenance and freshness.

Unknown balance means unknown, not zero.

---

# 7. Transactions Workspace

Build a strong Money → Transactions experience.

Support:

- server-side search
- filtering
- sorting
- cursor pagination
- date ranges
- account filters
- category filters
- merchant filters
- tag filters
- amount filters
- recurring filter
- transfer filter
- income/outflow filter
- saved views
- bulk operations
- notes

Use TanStack Table.

Do not load the entire database into the browser for filtering.

Opening a transaction should use a detail drawer/panel and preserve:
- filters
- table state
- scroll position
- keyboard focus where practical

The detail view should show:
- amount
- account
- date
- merchant
- category
- tags
- recurring status
- transfer/refund relationships
- note
- source/import
- original source description/data
- correction/activity history

---

# 8. Merchant Normalization and Categories

Automatically normalize merchant names where confidence is high.

Example:

```text
AMZN MKTP DE
Amazon EU
Amazon.de*XYZ
```

may become:

```text
Amazon
```

Automatic categories:

```text
high confidence → apply
medium → Review
low → Uncategorized
```

Uncertain categorization must not block otherwise valid transactions.

Categories, tags and financial events have different meanings:

```text
Category = what it was
Tag = flexible label
Event = contextual group such as a trip
```

Example:

```text
Category: Restaurant
Tags: Vacation, With friends
Event: Paris 2026
```

AI may suggest events/tags but should not create excessive semantic clutter automatically.

---

# 9. Corrections and Rules

A user correction immediately changes that object and propagates to dependent calculations.

Example:

```text
Amazon purchase
Shopping → Education
```

This does NOT automatically mean:

```text
All Amazon → Education
```

After a correction, optionally offer:

```text
Apply this to similar transactions…
```

Show:
- matching rule
- number of affected existing transactions
- effect on future imports

Require explicit approval before creating the broader rule.

Every meaningful canonical correction should have:
- audit history
- actor
- before/after
- Undo where safe

Undo is another explicit operation, not database time travel.

---

# 10. Transfers, Refunds and Pending Transactions

Implement these correctly.

## Transfers

Transfers between the user's own accounts are not income or spending.

They still affect individual account balances.

Fees remain expenses.

Credit-card repayments are transfers when both owned accounts are represented.

## Refunds

Refunds:
- link to the original transaction when possible
- reduce spending in the refund posting period
- are not income/salary

## Pending

Pending transactions remain distinguishable from posted transactions.

Do not count pending payments as posted historical spending.

Avoid deducting the same pending hold twice when an available balance already reflects it.

---

# 11. Recurring Payments and Income

Detect likely recurring series such as:

- salary
- rent
- Spotify
- utilities
- subscriptions
- recurring transfers

Show inferred patterns in Review.

Example:

```text
Spotify
€10.99 monthly
Detected from 4 payments

Confirm
Edit
Not recurring
```

Forecasting may use inferred recurring items immediately, but they must be clearly labelled as estimated.

User-confirmed recurrence takes precedence over future lower-confidence AI inference.

---

# 12. Multi-Currency

Support original transaction currency plus workspace display currency.

Keep:
- original amount
- original currency

Store derived conversion information separately:
- rate
- source
- date
- target currency

Changing display currency must not mutate original transactions.

If required FX information is unavailable:
- show a partial result
- or mark the calculation unavailable

Never silently treat unknown conversion as zero.

---

# 13. Goals

Implement first-class goals.

Examples:

```text
Japan
€3,500
July 2027
```

Support:
- target amount
- currency
- target date
- priority
- notes/status

Creating a goal does NOT automatically reserve money.

---

# 14. Goal Allocations

Allow virtual reservations.

Example:

```text
Reserve €500 of Commerzbank for Japan
```

This:
- reduces spendable cash
- affects available-to-spend
- affects forecasts

It does NOT:
- transfer money
- change real account balances
- change net worth

Prevent the same cash from being reserved twice.

---

# 15. Financial Model

Implement Plan → Financial Model.

This is the user's transparent view of what calculations assume.

Include conceptually:

```text
Income assumptions
Recurring expenses
Variable-spending assumptions
Safety rules
Account behavior
Goal allocations
Financial rules
AI-learned/inferred assumptions
```

Each item should show:
- current value
- source
- confidence where applicable
- whether user-confirmed
- edit/remove/disable actions

Keep these distinctions:

```text
facts
assumptions
financial rules
AI preferences
scenario overrides
```

They are not interchangeable.

---

# 16. Forecasting Engine

Create the forecasting engine as ordinary TypeScript application logic.

Do not ask an LLM to invent authoritative future balances.

Use a daily timeline internally.

Start from reliable dated account balances.

Incorporate:
- expected income
- confirmed/estimated recurring expenses
- variable spending assumptions
- goals/reservations
- financial rules
- future events
- scenario changes

Produce:

```text
Expected
Conservative
Optimistic
```

These are explicit assumption cases.

They are NOT statistical P10/P50/P90 probabilities.

Store assumptions used so results remain explainable.

---

# 17. Available to Spend

Default horizon:

```text
rolling 30 days
```

Allow the user to change it.

Use the Conservative case.

The logic should account for:
- spendable accounts
- current/reconciled balances
- expected income
- recurring obligations
- expected ordinary spending
- safety buffers
- protected goal allocations
- account-specific minimums
- pending holds exactly once

Evaluate daily.

Do not only look at the ending balance.

If a required balance or critical input is unknown:

```text
Available to Spend = Unavailable
```

Do not invent a number.

Explain:
- assumptions
- limiting date
- limiting account if applicable
- missing inputs
- major contributors

---

# 18. Spending Plans / Budgets

Treat budgets as targets, not predictions.

Keep two concepts separate:

```text
Behavior forecast
"What happens if I continue behaving normally?"

Plan forecast
"What happens if I follow this spending plan?"
```

Creating a lower restaurant budget must not magically change the behavior forecast.

AI may propose plans, but the user explicitly activates/accepts them.

---

# 19. Scenarios

Implement what-if scenarios as deltas over real financial state.

Do NOT clone the user's full financial model for every scenario.

Examples:

```text
Japan trip = €3,000
Rent +€200 starting January
Salary +€500/month
Laptop purchase = €1,200
```

Changing scenario parameters recalculates forecasts using the deterministic engine.

Scenario changes remain hypothetical until explicitly applied.

---

# 20. AI Finance Layer

Create a small controlled finance tool layer used by:

- UI
- AI
- workflows
- artifacts

The same business operation must not have separate implementations for each caller.

AI must never get:
- raw SQL
- database credentials
- unrestricted DB access

Give AI intent-specific tools.

Examples:

```text
accounts.list
accounts.getBalances

transactions.search
transactions.get

analytics.cashflow
analytics.spendingByCategory
analytics.comparePeriods
analytics.netWorth
analytics.availableToSpend

recurring.list
goals.list
goals.get

financialModel.get

forecast.evaluate

evidence.get
```

Canonical write tools can include operations such as:

```text
transactions.setCategory
transactions.addTag
recurring.confirm
goals.create
goals.changeTarget
goalAllocations.set
financialRules.create
financialAssumptions.confirm
scenarios.create
operations.undo
```

Every tool input must be validated with Zod.

Security context such as user/workspace must be injected server-side and never chosen by the model.

---

# 21. AI Interaction Rules

Implement four principal AI paths:

```text
Import interpretation
Financial assistant/chat
Deep Analysis
Artifact generation
```

Do not create a giant swarm of agents.

Use deterministic workflows around bounded model reasoning.

AI should receive minimum relevant context.

Do not dump thousands of transactions into prompts when application analytics can calculate the answer.

Example:

Bad:

```text
send 8,000 transactions to model
ask model to total restaurants
```

Good:

```text
analytics.spendingByCategory()
→ exact result
→ evidence
→ model explains result
```

---

# 22. OpenRouter

Use OpenRouter through a small internal adapter.

During development:
- free models only
- no paid fallback
- select a small tested list of compatible free models

Different capabilities may use different models.

Record:
- requested model
- actual resolved model
- capability
- status
- token usage where available
- latency
- errors

Keep prompts/version configuration in source code.

Do not build a prompt-management UI.

---

# 23. AI Chat

Implement persistent AI conversation threads.

The right-side AI panel should be available throughout the application.

It must understand removable context such as:

```text
Current transaction
Current account
Current goal
Current scenario
Current date-filtered view
```

Submitting a message captures its context at submission time.

Navigating afterward must not alter the context of the already-running request.

Current financial facts must always come from finance tools/database state, not an old conversation summary.

Long conversations may use:
- recent messages
- compact conversation summary
- persistent financial domain state

---

# 24. AI Writes

AI may freely:
- read permitted data
- investigate
- calculate through trusted tools
- create hypothetical scenarios
- create derived artifacts

AI may perform a canonical write when fulfilling an explicit user instruction.

Example:

```text
"Change this transaction to Groceries"
```

Execute and provide Undo.

AI should not silently change canonical state because it believes something would be better.

Bulk/rule changes must show scope before execution when appropriate.

---

# 25. Vercel Workflows

Use **Vercel Workflows** as the durable background execution system.

Do not introduce Redis or a separate worker service.

Long-running operations should continue after:
- navigation
- tab close
- browser disconnect
- user's computer shutting down

once the deployed backend has successfully started the workflow.

Use workflows for:
- import processing
- Deep Analysis
- large reclassification
- artifact generation/review
- analytics rebuilds where necessary
- scheduled reviews later if needed

Break work into bounded resumable steps.

Do not make one enormous function invocation.

Persist user-facing job state in Supabase.

At minimum:

```text
job
type
status
current stage
created/start/completion timestamps
result reference
error reference
workflow run ID
workspace
```

Support:
- Stop/cancel
- Retry where safe
- visible errors
- preserved partial completed work

Use stages rather than fake progress percentages when a real percentage cannot be calculated.

---

# 26. Idempotency and Concurrency

Every important mutation/background-start operation should be retry-safe.

Prevent:
- double imports
- duplicate goal creation from retried calls
- repeated AI canonical writes
- duplicate background tasks from double-clicking

Use idempotency keys where appropriate.

Mutable canonical objects should have versions where concurrent edits matter.

A stale mutation should produce a conflict rather than overwrite newer data.

---

# 27. Deep Financial Analysis

After the first confirmed import batch:

1. show reliable financial data immediately
2. start Deep Analysis in the background

Do not make Home blank while AI is working.

Deep Analysis should conceptually run:

```text
Create/freeze analysis input
↓
Deterministic baseline metrics
↓
Identify investigation candidates
↓
Bounded AI investigation
↓
Evidence validation
↓
Synthesis
↓
Recommendations
↓
Reviewer where valuable
↓
Save completed analysis
↓
Generate artifacts when useful
↓
Notify user
```

At minimum inspect:
- balances/net worth
- cash flow
- income
- spending
- categories
- recurring commitments
- unusual patterns
- goals
- forecast
- planning risks/opportunities

Use one bounded investigation unless multiple investigators clearly add value.

Do not call extra models just to create an impressive-looking agent architecture.

---

# 28. Evidence

Every important AI financial claim should be inspectable.

Example:

```text
Food spending increased 27%
```

The UI should allow the user to inspect:
- periods compared
- calculation
- relevant categories/merchants
- supporting transactions where appropriate

AI numerical claims should come from deterministic tool results.

If evidence does not support a claim:
- remove it
- or clearly mark uncertainty

Do not let AI arithmetic become authoritative financial truth.

---

# 29. Saved Analyses

Deep analyses are historical snapshots.

Do not silently rewrite old reviews when new financial data arrives.

Store:
- date
- data cutoff/input snapshot/reference
- findings
- recommendations
- evidence
- related artifacts

Allow later comparison such as:

```text
What changed since my September review?
```

---

# 30. Home

Implement a polished useful Home dashboard.

Top metrics:

```text
Net Worth
Available to Spend
This Month
```

Also support:
- cash flow
- account balances
- upcoming recurring payments
- goals
- recommendations
- pinned generated tools

Initial dashboard may be personalized based on available financial data.

After initial setup, AI should not rearrange the dashboard without user instruction.

Add explicit Customize mode.

Allow:
- add
- remove
- reorder
- resize
- configure
- pin artifact

Use Save / Cancel for layout editing.

Show data freshness where meaningful.

---

# 31. Home Insights

Show at most approximately three prominent high-value insights initially with a **See all** path.

Examples:
- spending changed materially
- upcoming commitments
- goal falling behind

Dismissed insights should not immediately reappear unless the underlying situation materially changes.

Home insights are distinct from:
- Review items
- notifications

---

# 32. Review

Money → Review is where uncertainty is handled.

Possible groups:

```text
Needs attention
Uncertain
Possible duplicates
Transfers
Recurring
Unusual
Resolved
```

Review items should contain evidence and confidence where useful.

Support:
- manual resolution
- AI-assisted resolution
- batch resolution where safe
- Undo

---

# 33. Search

Implement ordinary search without requiring AI.

Natural-language filtering such as:

```text
restaurants over €20 last month
```

should become visible editable transaction filters.

Do not translate arbitrary model text directly into SQL.

Analytical questions such as:

```text
Why was March expensive?
```

should hand off to the persistent AI experience.

---

# 34. Generated Artifacts

Artifacts are persistent AI-generated financial mini-tools.

Examples:
- spending explorer
- trip planner
- goal tracker
- report
- comparison
- timeline
- scenario simulator

Do not create an artifact merely because a question is complex.

Generate one when an interactive/reusable tool genuinely adds value.

Successful artifacts should automatically save to:

```text
AI → Library
```

Pinning to a dashboard remains the user's choice.

---

# 35. Artifact Model

An artifact should have:
- stable artifact identity
- versions
- active version
- source/code
- state
- permissions
- created-by conversation/run
- activity
- timestamps

Editing the artifact creates another version of the same artifact.

A failed edit must never destroy the last working version.

---

# 36. Artifact Runtime Prototype

This is an important feasibility feature.

Implement the simplest safe prototype consistent with this architecture:

```text
Generated source
↓
validation/build
↓
trusted renderer
↓
generated JavaScript execution isolated using QuickJS/WASM in a Web Worker
↓
controlled Finance SDK
```

Generated JavaScript must not directly receive:
- `window`
- `document`
- cookies
- localStorage
- sessionStorage
- unrestricted fetch
- database credentials
- OpenRouter credentials
- raw backend tokens

The Finance SDK should expose only approved operations.

Start with:
- balances
- spending analytics
- cash flow
- goals
- scenario forecast

Use trusted application chart primitives backed by Apache ECharts.

Do not build a complete browser inside the sandbox.

Implement the smallest runtime capable of proving the concept safely.

---

# 37. Artifact Interaction

Interactive controls such as sliders should call deterministic finance calculations.

Changing:

```text
Hotel budget €900 → €1,200
```

must NOT require another AI call merely to update the forecast.

Debounce rapidly changing inputs appropriately.

A tool can have local illustrative calculations, but clearly distinguish them from authoritative finance-engine results.

---

# 38. Artifact State

Artifact-local state persists.

Example:

```text
Trip length
Hotel budget
Flight price
Selected scenario
```

Changing artifact-local state must not silently modify the Financial Model.

If the artifact offers:

```text
Apply this to Japan goal
```

that must use a host-mediated explicit canonical operation with normal:
- validation
- audit
- concurrency
- Undo

---

# 39. Artifact Versions

Every generated/edited candidate must pass validation before becoming active.

At minimum:
- allowed source/API checks
- valid artifact manifest
- code execution smoke test
- missing-data handling
- basic resource/runtime checks
- no unauthorized Finance SDK calls

If validation fails:
- keep previous active version
- show the error
- allow fixing/retry

Code edits must preserve compatible artifact state.

---

# 40. Prototype Three Artifacts

Before creating a huge general artifact platform, ensure these three work:

## Spending Explorer
- visual spending analysis
- filters
- live data
- evidence/drilldown

## Trip Planner
- configurable cost assumptions
- deterministic scenario forecast
- effect on available cash/goals

## Goal Tracker
- current allocation
- required saving pace
- forecasted progress
- what-if inputs

Test:
- creation
- persistence
- reopen
- version edit
- data refresh
- missing financial inputs
- permission restrictions
- stopping a broken/looping artifact

---

# 41. AI Library and Activity

AI section should include:

```text
Chat
Deep Analysis
Library
Activity
```

Library stores generated artifacts and saved analyses/conversations as appropriate.

Activity shows meaningful operational information such as:

```text
Read 821 transactions
Calculated cash flow
Ran forecast
Changed 12 categories
Generated Trip Planner v2
```

Do not expose hidden chain-of-thought.

Do not copy full raw financial datasets into an activity log.

---

# 42. Notifications

Initially implement in-app notifications only.

Examples:
- import completed
- Deep Analysis completed
- important financial warning
- recurring charge changed materially
- goal warning

Notifications should deep-link to the relevant object/result.

Do not add email/push infrastructure yet.

---

# 43. Frontend Architecture

Keep:

```text
Home
Money
Plan
AI
Settings
```

Settings stays secondary.

Persistent AI panel on the right.

Keep the layout stable and desktop-first.

Use:
- Server Components for non-interactive shell/bootstrap where sensible
- Client Components only where needed
- TanStack Query for interactive server state
- React state/context for local UI
- URL params for shareable/filter/navigation state

Do not put sensitive descriptions, prompts or account identifiers into URLs.

---

# 44. Loading / Error / Missing States

Explicitly distinguish:

```text
Loading
Empty
Partial
Stale
Unavailable
Error
Permission excluded
Background refreshing
```

Never use `0` to mean both:
- legitimate zero
- failed/unavailable data

A failed dashboard widget must not crash the whole dashboard.

---

# 45. Accessibility and UX

Keep the interface polished and power-user friendly.

Support:
- keyboard navigation
- visible focus
- accessible labels
- accessible charts
- light/dark/system
- comfortable/compact density

Use existing shadcn/ui components where practical.

Do not build custom primitives when a stable existing component already solves the problem cleanly.

---

# 46. Testing

Use:
- Vitest
- Playwright

Write meaningful tests while implementing.

Prioritize tests around financial correctness and critical workflows.

At minimum test:

## Finance
- exact money calculations
- transfers
- refunds
- pending transactions
- allocations
- Available to Spend
- scenarios
- forecasts
- currency handling

## Import
- valid CSV
- valid XLSX
- overlapping imports
- legitimate identical transactions
- ambiguous duplicates
- retry/restart behavior
- corrections preserved

## Security
- workspace isolation
- unauthorized finance operations
- AI cannot select another workspace
- artifact permission denial

## Workflows
- resume/retry safety
- cancellation
- duplicate submissions
- browser can disconnect without losing deployed background work

## E2E

The following must work as one complete Playwright journey:

```text
authenticate
↓
upload sample finance files
↓
confirm AI mapping
↓
import
↓
review/correct transaction
↓
view Home
↓
ask grounded AI question
↓
create goal
↓
run scenario/forecast
↓
complete Deep Analysis
↓
generate artifact
↓
pin artifact
↓
import newer data
↓
verify dependent data/artifact updates
```

Use deterministic synthetic test fixtures.

Routine automated tests should mock AI responses instead of consuming OpenRouter quota.

Use real free-model calls only for targeted smoke/evaluation testing.

---

# 47. Hardening

Before declaring the implementation complete:

1. run TypeScript type checking
2. run lint/format checks
3. run unit tests
4. run integration tests
5. run Playwright flows
6. run production Next.js build
7. inspect DB migrations
8. test RLS/workspace isolation
9. test duplicate import behavior
10. test workflow retries/cancellation
11. test artifact runtime failures
12. test missing/partial financial data
13. test no paid OpenRouter fallback
14. remove obvious dead code
15. remove temporary debugging code
16. remove unnecessary dependencies
17. resolve obvious TODOs affecting the core product
18. review architecture for unnecessary complexity

Perform an adversarial review of your own implementation after the first complete pass.

Fix the issues you find rather than merely listing them.

---

# 48. Code Quality

Aim for code another strong engineer can understand quickly.

Prefer:

```text
small clear functions
explicit domain names
simple modules
typed boundaries
few dependencies
shared business logic
tests around important invariants
```

Avoid:

```text
God services
giant React components
generic managers
generic repositories for everything
deep class hierarchies
magic event systems
unnecessary dependency injection
unnecessary factories
unnecessary wrappers
premature scalability infrastructure
```

Do not create abstractions before having at least one real use for them.

Duplicating three simple lines can be better than building a generic framework whose purpose is unclear.

However, financial business logic must not be duplicated between:
- UI
- AI
- workflows
- artifacts

That logic belongs in shared domain/application functions.

---

# 49. Supabase Storage

Create the required private Storage structure for uploaded financial files and product-generated files.

At minimum support private storage for:
- original CSV/XLSX imports
- artifact/export files where needed

Never expose uploaded financial files through public buckets.

Store references in PostgreSQL rather than assuming local filesystem persistence.

---

# 50. Future Bank Connections

Do NOT implement live banking now.

But make the ingestion model compatible with:

```text
CSV source
XLSX source
manual source
future bank API source
```

A future connected bank account must be able to attach to an existing canonical account rather than create a duplicate financial history.

Do not over-engineer the connector abstraction beyond what is necessary to preserve this possibility.

---

# 51. Explicitly Out of Scope

Do not implement:

- money transfers
- payments
- stock purchases
- subscription cancellation
- public artifact sharing
- live bank connection now
- mobile native app
- Python backend
- probabilistic Monte Carlo finance claims
- investment return prediction
- speculative FX forecasting
- household collaboration UI
- enormous prompt-management system
- arbitrary npm packages inside generated artifacts
- arbitrary generated-code network access
- a complete plugin ecosystem
- production backup infrastructure beyond what already exists
- unnecessary production observability infrastructure

---

# 52. Definition of Done

Do not call the work complete just because individual pages exist.

The implementation is complete for this pass when:

### Import
A real CSV/XLSX file can be uploaded, interpreted, previewed, confirmed and imported.

### Financial model
Accepted transactions/accounts become trusted canonical financial state.

### Money
The user can meaningfully browse, search, filter, inspect and correct finances.

### Planning
Goals, allocations, assumptions, scenarios and forecasts work.

### AI
The assistant can answer questions through real finance tools and provide evidence.

### Background work
Long operations use Vercel Workflows and remain durable after browser disconnect.

### Deep Analysis
A real saved evidence-backed financial review can complete.

### Artifacts
At least the three prototype artifact types work through the isolated runtime and Finance SDK.

### Dashboard
Home can show trusted finance widgets and pinned generated tools.

### Refresh
Importing newer data updates dependent trusted metrics and live tools without unnecessary AI regeneration.

### Safety
RLS/workspace isolation, validation, idempotency and basic artifact boundaries work.

### Quality
Build, tests and critical end-to-end flows pass.

---

# 53. Final Review

After implementation, perform one final full review from four perspectives:

## Product review
Does the complete experience feel coherent rather than like disconnected features?

## Engineering review
Is the implementation simple, readable and maintainable?

## Financial correctness review
Could any calculation, import, transfer, refund, currency conversion, reservation or forecast easily mislead the user?

## Adversarial review
Try to break:
- tenant isolation
- imports
- duplicate detection
- workflow retries
- AI tool boundaries
- canonical writes
- artifact sandbox
- artifact permissions
- state/version handling

Fix issues found during this review.

---

# 54. Final Deliverable

When finished, provide a concise implementation report containing:

1. what was implemented
2. important architecture decisions actually used
3. migrations/tables/storage created
4. routes/screens completed
5. background workflows implemented
6. AI capabilities/tools implemented
7. artifact runtime status
8. tests run and results
9. remaining known limitations
10. anything that could not be verified because of unavailable external credentials/services

Do not fill the report with trivial file-by-file descriptions.

The repository itself is the primary deliverable.

---

# Most Important Rule

Build the **simplest serious implementation that actually works end-to-end**.

Do not spend the majority of the work designing infrastructure for hypothetical future scale.

The key architectural principle is:

> Financial data and deterministic application logic are the source of truth. AI is an intelligent caller of that system, not the financial system itself.

And the key product test is:

> Import → correct → understand → ask → plan → analyze → generate useful tool → pin → import newer data → everything stays coherent.