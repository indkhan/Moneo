# Moneo completion orchestrator prompt

You are the lead engineer and orchestrator for Moneo in `C:\codebases\Moneo`. Implement and finish the import-first product described in `plan.md` and the decisions below. This is an execution request, not a request for another plan or interview. Start working immediately, delegate to agents, integrate their changes, and keep progressing until the acceptance criteria are satisfied or a genuine external blocker prevents remaining work.
for each thing do the stuff commit by commit 
Read `AGENTS.md`, `plan.md`, `qa-baseline.md`, relevant code, and installed skills before acting. This prompt records the owner's product decisions and authorizes the work. Follow higher-priority system/tool instructions. Do not reopen settled questions; make routine decisions yourself and record consequential assumptions. Never pretend that a prompt can remove runtime limits, unavailable credentials, or service outages.

## Scope and authority

- Build the complete import-first application. Bank connections are deferred. Preserve a straightforward route to Germany-first, then EU read-only integrations without implementing a speculative provider framework.
- Initially one person uses it. Maintain private workspace ownership, authentication, RLS, and cross-user isolation now so other users can use it later. Do not build household sharing, SaaS billing, or public sharing.
- The existing deployment is `https://moneo-mu.vercel.app`. Vercel and Supabase are already configured; inspect existing setup rather than creating a new deployment/project.
- You may modify code/configuration, add justified dependencies, create branches and commits, apply migrations, push, create/merge PRs, and verify the resulting Vercel deployment. No repeated permission requests for these authorized actions. Respect any tool-required approvals and never claim an action succeeded if it was rejected.
- The owner says existing application data is disposable. You may reset/reseed it when needed. First identify the exact configured project and target; prefer disposable test workspaces and targeted cleanup over a broad reset. Never delete unrelated projects, files, users, or infrastructure. Data disposability does not authorize committing statements or credentials.
- Keep changes in small coherent commits per completed feature/fix. Preserve unrelated user edits. Coordinate Git centrally. Do not force-push or rewrite shared history unnecessarily. Verify changes before pushing/merging; check deployment and migration state afterward.
- Keep OpenRouter and existing credentials. You may add task-specific free-model settings to `.env` and documented placeholder/default settings to `.env.example`. Verify current model availability, zero pricing, capability support, and actual operation before choosing models. Never print or commit secrets. No paid models/services without separate explicit authorization.
- Outside scope: money movement, payments, trading, tax filing, subscription cancellation, public artifact sharing, and a full per-capability prompt-management interface.

## Product decisions

Use EUR, an English interface, Europe/Berlin, multiple currencies, and calendar-month budgets by default. Make relevant preferences editable. Preserve original currencies and amounts; conversions require dated evidence. Handle European and US statement formats explicitly. Ambiguous amounts/dates/account routing require an in-app review, never a silent guess.

The owner supplied two root-level CSV statements. Discover their current filenames rather than depending on the audit filenames. Treat their contents and filenames as private. Use them locally for acceptance, never stage or publish them, and derive anonymized synthetic regression fixtures. Neither file is automatically a single account: one supplied file contains both Current and Savings products. Detect/account for product/account/currency routing, fee semantics, source status values, transfers, refunds, and balance chronology. Preserve original rows and evidence.

Refine the current design where it materially improves usability. Build a coherent desktop-first experience with usable mobile layouts, light/dark appearance, keyboard navigation, proper labels/focus/error states, and WCAG 2.2 AA as the target. Remove development prototypes from ordinary product screens. Keep the core screens usable without chat.

## Orchestration process

You are responsible for the complete result, not merely agent assignments. Use the runtime's actual agent tools; do not invent APIs or attempt unlimited simultaneous agents.

1. Inspect Git status, deployed/local baseline, environment names without revealing values, supplied fixtures, migrations, and current failures. Reproduce baseline findings because the repository may have changed since the audit.
2. Create `implementation-progress.md` with a requirement checklist, dependencies, acceptance criteria, assigned file ownership, verified results, commit IDs, decisions, and blockers. Keep it concise and current. Mark items complete only with evidence.
3. Break work into bounded vertical slices. Prioritize import/financial correctness before polishing or expanding outputs built on that data. Give each agent a specific outcome, owned paths, dependencies, acceptance cases, and reporting format.
4. Delegate independent work up to the available concurrency limit. Suggested roles: financial correctness/imports/database; Money/Plan workflows; AI/artifacts/settings; UI/journey QA. Roles are temporary assignments, not a new application framework.
5. Avoid simultaneous edits to shared schema, migrations, navigation, common financial functions, or tests. Assign an owner, sequence dependencies, and coordinate schema/interface changes before consumers implement them. Use isolated worktrees when helpful. Never run multiple builds/dev servers against the same `.next` directory.
6. Require agents to report changed files, behavior, tests actually run, residual risks, and any blocker. Independently inspect every diff and validate integration. An agent saying done is not acceptance evidence.
7. Have another agent review each substantial slice for correctness, financial semantics, security, plan coverage, and unnecessary complexity. Address findings before accepting it. Do not build an endless review loop: close actionable findings and move on.
8. Run the smallest relevant checks during development and commit coherent verified slices. After integration, run the full gates and live journeys. Fix root causes and relevant sibling callers rather than patching symptoms at individual screens.
9. Keep assigning the next ready slice while other agents work. When a dependency is externally blocked, continue independent work, then record the exact blocked capability and evidence. Never replace real integration with a mock and call it finished.
10. Continue across compaction/restarts by rereading the progress document and Git state. Before a runtime limit ends work, persist the next concrete steps and verification state. A time limit does not mean complete. Do not keep spawning agents once the definition of done is met.

Use existing utilities, installed dependencies, standard APIs, and nearby patterns before introducing new abstractions. Read the relevant installed Next.js guides before writing framework-sensitive code. Use meaningful regression tests for financial/security branches and broken journeys; avoid tests that merely mirror implementation.

## Financial truth and correction propagation

Keep application money in integer minor units/`bigint`, with explicit currency and precision-safe serialization. Do not let generated code, AI prose, or floating-point arithmetic define canonical financial truth. Percentage/rate calculations require explicit rounding rules and deterministic application code. Keep numeric chart coordinates separate from exact displayed totals.

Establish consistent rules for dated opening/current balances, snapshot boundary times, ledger reconciliation after a snapshot, pending holds, refunds, transfers, fees, debt signs, FX dates, and valuation dates. Show stale/missing data rather than presenting old balances as current. Do not count transactions both in an imported balance and again as a later delta. Handle same-day snapshot ordering and mixed product balances explicitly.

Corrections, splits, links, deletes, import undo, and planning edits must be audited, versioned/concurrency-safe, and reversible where appropriate. Preserve sources and original records. Propagate corrections to Home, budgets, goals, forecasts, recurring inference, tool snapshots, search, and subsequent AI reviews. Invalidate/review derived assumptions when their evidence changes, while preserving intentional user overrides. Keep old saved reviews historically accurate and visibly dated/stale rather than rewriting them.

Support cross-currency transfers and partial/multiple refunds explicitly. Preserve each leg's original amount/currency; transferred principal is not income/spending, and fees are separate. Require dated FX evidence for comparisons rather than inventing a rate. Refunds retain their posting currency and attributable category; never relabel an amount into the original purchase currency without conversion. Test unmatched legs, partial refunds, multiple refunds, currency conversion, and undo.

Each new schema change gets a new ordered migration. Keep `lib/db/schema.ts` aligned with tables, columns, relationships, deletion behavior, indexes, and constraints. Check both a fresh migration path and the existing deployed migration path. Preserve RLS and workspace-scoped relationships; service-role workflows must enforce their own scope.

## Home

Deliver balances, net worth, estimated available-to-spend, current spending/comparisons, upcoming payments, goals, and selective important insights. Include dates, currency, provenance, partial-result labels, and links to resolve missing data. Home is the financial overview; do not add another Money Overview page.

Support persisted dashboard customization combining built-in widgets and saved AI tools. Allow pin/unpin, ordering, and useful widget/summary/opening shortcuts; a full miniature tool UI is optional. The initial reviewed import should produce an evidence-backed financial review and useful personalized dashboard choices, with user control.

## Money

Deliver accounts and transactions plus recurring payments, investments, assets, and debt. Include manual transaction entry; meaningful account editing/archive behavior; search/filter/sort; saved views; bulk editing/categorization/tagging; split transactions; trip/event spending groups; merchant/category review; transfer/refund linking; source evidence; history and undo. Prevent double counting between parent transactions and splits.

Treat recurring patterns as inferred until reviewed. Support confirmation, correction, dismissal, effective dates, and historical evidence. Changes affect future forecasts consistently. Do not categorize every inbound payment as income or every outbound payment as consumption when it is a transfer, savings movement, investment contribution, or debt principal.

Investment tracking includes holdings, quantity, manually entered prices, dated valuations, cost basis, and deterministic performance where enough inputs exist. Asset tracking includes dated manual valuations. Debt tracking includes balances, rates, repayment schedules, and scenario impact. No trading, tax workflow, or paid market-data dependency. Use exact decimal handling for quantities/prices and explicit currencies.

## Plan and Financial Model

Deliver richer goals: targets/dates, priority, allocations, progress, expected completion, contribution plans, affordability, and comparisons. Reservations never move money and cannot double-allocate cash. Distinguish actual saved money, virtual reservations, and future planned contributions.

Deliver calendar-month category budgets with optional rollover, spending plans, and progress based on correct posted/transfer/refund/split rules. Support forecasts up to 12 months and what-if scenarios with understandable comparisons. Future scenarios do not alter actual financial records.

Use confirmed recurring income/expenses plus explicit estimated spending where justified; avoid counting both recurring events and the same budget allowance. Show expected/conservative/optimistic cases, the limiting date, missing inputs, and editable rules. These cases are assumptions, not fabricated probabilities. Make safety buffers/forecast preferences explicit and editable; choose reasonable documented defaults.

Financial Model is the central area for the facts, assumptions, and rules used across the app, with provenance, editing controls, enabled/confirmed state, and history. Include relevant balance/valuation/FX sources and planning defaults. Use Europe/Berlin calendar periods and test DST, month boundaries, leap years, and end-of-month recurrence.

## AI and application orchestration

Deliver persistent conversations, a consistent contextual side panel, thorough saved financial reviews, a tool library, and visible activity history. Support cancellation and honest queued/running/completed/failed/canceled states across chat, reviews, generation, and background work. Preserve useful partial work where safe; cancel must prevent new writes after cancellation becomes effective.

Build a bounded in-app AI orchestration flow using existing server tools and durable workflows: choose whether to answer, investigate, review, propose an action, create/update a tool, or surface an insight. Ground decisions in current data and user goals/preferences. This application orchestration is separate from your coding sub-agents. Do not make ordinary application use depend on recursive agent spawning, endless model loops, or an always-running process.

Reviews should investigate category/merchant/period changes, obligations, budgets, goals, forecast pressure, asset/debt context, and missing data when relevant. Use exact tool results and source links, meaningful comparison periods, and confidence/limitations. A useful answer does not always need a generated tool.

The owner authorizes AI-assisted edits. Clear commands may execute validated, targeted, audited, undoable internal changes. Ambiguous, destructive, or broad/bulk operations get a product-level impact preview/confirmation. Do not confuse development authorization with authorization for arbitrary financial mutations by the model. Validate action and target independently of language heuristics, require unambiguous record selection, and enforce permissions/idempotency/concurrency server-side. Treat imported descriptions, chat context, and model output as untrusted data.

## Settings and insights

Add a usable profile/settings area for display currency, timezone/locale, theme, AI provider/model choices, AI data-access scopes, usage visibility, insight preferences, and scheduled-summary preferences. Apply settings to every entry point, including background jobs and artifacts. Explain what information goes to the provider. Send only required scoped data; never send secrets. Ordinary chat should not receive raw files by default.

Support customizable in-app insight types for spending changes, budget pressure, unusual activity, recurring/subscription changes, upcoming obligations, cash shortfall, goal progress, debt/investment/asset context, and data-quality warnings where evidence supports them. Provide dismissal/muting, deduplication, relevance controls, and links to evidence. Do not manufacture precision or alerts without a credible basis.

Deliver optional weekly/monthly scheduled summaries and on-demand reviews, configurable in settings. Persist runs/results with visible status and cancellation. Schedule with infrastructure compatible with the existing Vercel/Supabase deployment; verify actual recurring execution where accessible. No email or push notifications. Do not add a paid scheduling service.

Use task-specific free models only when verified to improve the relevant capability. Keep a simple default/fallback strategy, clear rate-limit/provider errors, and bounded generation time/steps. Show actual usage information available from the provider and label unknown costs/usage. Test model-dependent behavior deterministically and also verify representative live operations; mock success is not proof of provider functionality.

## Generated financial tools

The owner wants full creative freedom: support useful planners, trackers, reports, comparisons, and reusable interactive tools beyond the existing three types, with live scoped data, remembered settings, AI editing, direct code editing, validation, versions/restore, dashboard integration, and PDF/image exports.

Creative freedom never means unrestricted execution. Preserve isolation, validation, memory/time/output limits, and permission boundaries. Broaden manifests, host-approved financial operations, and renderers only as necessary to deliver the requested capabilities. Generated code cannot access credentials, unrestricted network, host DOM/storage, or the canonical ledger. Financial actions remain validated host operations under explicit user authorization. Tool code calculates from supplied financial snapshots; any proposed new financial formula needs deterministic application validation before becoming canonical truth.

Validate before activation and keep the previous working version on failure. Test missing data, invalid code, runaway loops, oversized output, stale state, permission denial, and version restore. State persistence is artifact-local. Exports must render correct readable amounts/dates/currencies and meaningful empty/missing-data states.

## Acceptance journeys

Define expected results before testing. Do not infer expected financial truth from the implementation under test. Use independent exact fixture calculations and source evidence.

- Import both supplied statements through actual parsing, mapping review, confirmation, durable processing, persisted ledger/source/balance records, and resulting Home/Money/Plan/tools. Verify account/product routing, fees, status normalization, transfers/refunds, balances, dates, row totals, and exact per-account/currency money totals. Confirm a byte-identical repeat is idempotent and overlapping statements need appropriate review. Check source preservation, rejected/uncertain rows, retry/resume/cancel and undo. Large imports show useful progress and have bounded work, not silent hangs.
- Create manual records, categorize/tag/split/group/bulk-edit, link transfers/refunds, and save/reopen views. Correct and undo; verify every dependent total and review state. Assert no data loss or double counting.
- Establish known balances, expenses, income, pending transactions, FX, debts, goals, allocations, budgets, assumptions, and scenarios. Assert exact expected available-to-spend and forecast results. Test missing/stale balances, insufficient cash, allocation conflicts, month rollover, and currency differences.
- Ask grounded questions, reopen a conversation, use context, run/save/cancel a review, perform an explicitly authorized change, reject ambiguous/adversarial writes, and change permissions/models/preferences. Verify action/activity history, provider failure behavior, and scoped data access.
- Generate a useful tool, save settings, edit by AI and code, reject invalid revisions, restore a previous version, pin/reorder/unpin, see corrected live data, stop execution, and export PDF/PNG. Test real browser worker execution, not only server-side sandbox unit checks.
- Verify insights/settings and scheduled summaries against deterministic time, user preferences, cancellation, deduplication, and evidence freshness.
- Exercise investments/assets/debt and their effect on net worth versus liquid spending ability. Never treat an asset valuation as spendable cash.
- Authenticate two disposable users and prove no cross-workspace reads/writes via pages, APIs, RPCs, files, artifacts, or workflows. Keep test-auth setup out of production code. Test empty states, failures, keyboard use, mobile overflow, and dark appearance.
- After any push/merge, check actual deployed commit, applied migrations, health, authentication, representative import/journey behavior, and runtime logs where accessible. Local build success alone does not prove the deployed app works.

## Definition of done

Every in-scope clause in `plan.md` and this prompt maps to implemented behavior and acceptance evidence in `implementation-progress.md`. Run `npm test`, `npm run lint`, `npm run build`, and relevant/full Playwright journeys against the final integrated revision. Repair stale assertions to verify intended behavior without weakening financial/security checks. Required authenticated tests must run; a skipped test is not a pass. Check migration/schema alignment, fresh and upgraded database behavior, sandbox boundaries, and user isolation.

No known high/medium correctness, data-loss, security, or essential journey defect remains unresolved. No hidden prototype/TODO or mocked backend stands in for an accepted requirement. The two private CSVs, auth sessions, secrets, and sensitive logs are not committed. Clean up only your test data, temporary servers/helpers, and instrumentation; preserve user edits and fixtures.

Conclude with actual implemented coverage, commit/PR/deployment status, commands and results, acceptance evidence, and any specific external blocker. Do not claim perfection or completion because time was spent, agents agreed, or a checklist was checked without proof. If blockers remain, explicitly mark the affected criteria incomplete and provide the exact next step; finish everything independent of them first.

Begin now by reproducing `qa-baseline.md`, creating the progress checklist, and assigning the first independent bounded tasks.
