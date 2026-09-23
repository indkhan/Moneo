# Epics, waves and release coverage

All epics are R1. All are **Not started** until their story evidence exists. Canonical individual status lives in [STORIES.md](STORIES.md). A wave is an ordering aid; explicit story dependencies win over this table. E00 proofs can reject a proposed implementation while preserving the product requirement.

| Wave | Epics | Entry and exit |
|---|---|---|
| W0 — Prove the hard boundaries | E00 | Start with synthetic proof harness. Exit with evidence for restricted editable artifacts, import fidelity, job recovery, identity/provider feasibility and explicit decisions. No customer data. |
| W1 — Deploy an isolated slice | E01 | E00 decisions available. Exit with authenticated two-tenant application, real data isolation, deployed synthetic smoke and working CI/review checks. |
| W2 — Trust imported money | E02, E03 | E01 complete. Interleave by story dependencies. Exit with automatic import/review/correction, exact native/base-currency figures and second-import correctness. |
| W3 — Make data useful through AI and artifacts | E04, E05 | E03 complete. Manual artifact development can proceed alongside AI; AI editing waits for E04 tools. Exit with grounded conversation and a saved editable tool that refreshes from trusted data. |
| W4 — Deliver the first complete experience | E06, E07 | E04/E05 complete. Exit with deterministic planning, bounded initial analysis, usable Home and full core-loop demonstration. |
| W5 — Earn external beta readiness | E08 | Prior integrated journeys pass. Exit with security/restore/privacy/performance gates and controlled-beta evidence. Public launch is a separate founder decision. |

## E00 — Feasibility and proof harness (5 stories)

**Outcome:** Replace the riskiest assumptions with runnable evidence before building dependent product surfaces. Architecture §540 controls the required proofs.

**Stories:** E00-S01 through E00-S05. Detailed, Ready specifications are in the story ledger. S01 must finish before any other E00 story starts.

**Exit demonstration:** Execute synthetic artifact attacks and termination, import golden fixtures, worker death/queue-loss recovery, and identity/provider qualification. Capture browser/provider/version/resource limits and unresolved constraints. A failed safety proof blocks the affected product implementation; a mocked provider test alone does not qualify a live model. Do not market these prototypes as production implementations. Carry forward useful proven code where appropriate; remove discarded experiments.

## E01 — Foundation with real tenant isolation (6 stories)

**Outcome:** An authenticated deployed application slice with server-enforced tenancy, versioned contracts and repeatable verification.

**Stories:** E01-S01 through E01-S06. Build only the web/domain/data/worker boundaries already consumed by stories, not the full conceptual package tree.

**Exit demonstration:** Two synthetic users sign in and create isolated workspaces. Tenant-swapped IDs fail in API and real database tests, session revocation stops access, optimistic conflict is visible, and local/CI/staging run the same critical smoke. No privileged worker bypasses isolation by convenience.

## E02 — Durable, mostly automatic ingestion (7 stories)

**Outcome:** Upload a batch of CSV/XLSX files, infer mappings, validate before commitment, resolve material ambiguities only, and preserve accepted work across failures.

**Stories:** E02-S01 through E02-S07. Build the real job/command boundary before accepting imports. Parsing and AI mapping are proposals; deterministic validation owns canonical writes. Manual mapping is a fallback, not a compulsory onboarding step.

**Exit demonstration:** Multi-file upload reaches usable data without routine mapping clicks, an ambiguous amount/currency pauses only affected work, an overlapping second upload does not double money, legitimate identical transactions survive, and kill/retry/cancel/Redis-loss tests preserve effects and source history.

## E03 — Financial truth and usable money UI (8 stories)

**Outcome:** The user and every downstream tool consume the same exact, explainable financial figures and corrections.

**Stories:** E03-S01 through E03-S08. Native values remain canonical; unavailable valuation and incomplete balance coverage remain visible. All corrections use shared commands/audit/version checks.

**Exit demonstration:** Independently calculated multi-account fixtures cover transfers, fees, credit repayments, refunds, partial FX and dated balances. The user corrects rows in the table/drawer, bulk-edits categories, undoes a supported correction and confirms recurring items. Totals update without rewriting old evidence.

## E04 — Grounded durable AI (7 stories)

**Outcome:** Persistent chat can investigate authorized financial facts, show frozen evidence, use bounded tools, stop safely and survive worker loss.

**Stories:** E04-S01 through E04-S07. One worker-owned loop; no mandatory specialist swarm, raw SQL tool or vector database. Account exclusions precede disclosure, including ingestion mapping where applicable.

**Exit demonstration:** An answer matches golden calculations and links evidence; unsupported questions abstain. Concurrent calls cannot bypass budgets, excluded accounts do not reach new dispatches, policy changes block stale publication, and Stop/restart do not duplicate actions. Model evaluations distinguish correctness from provider availability.

## E05 — Editable live artifacts (7 stories)

**Outcome:** Save and edit supported HTML/CSS/JS in a restricted runtime, backed by scoped live queries and immutable recoverable versions.

**Stories:** E05-S01 through E05-S07. The E00 runtime proof is mandatory input, not a replacement for product runtime review. No arbitrary npm, unrestricted browser DOM or network fallback.

**Exit demonstration:** Create a chart and interactive scenario tool; manually edit and ask AI to edit; pin/reopen; second import refreshes without a model call. Failed builds/state migrations retain the working version. Host-confirmed actions cannot be forged, revocation takes effect, and runaway/hostile code is contained in supported browsers.

## E06 — Deterministic planning (5 stories)

**Outcome:** Basic goals and explicit daily cash cases support understandable what-if decisions without probability claims.

**Stories:** E06-S01 through E06-S05. Flat scenarios only. Expected/Conservative/Optimistic are named assumptions; all outputs carry dated balances, coverage and provenance.

**Exit demonstration:** Month-end/leap-year daily fixtures reproduce exact balances; competing goal allocations cannot double-reserve funds; transfers respect account liquidity; missing inputs make Available to Spend unavailable. Scenario comparisons leave source transactions unchanged.

## E07 — Initial analysis and Home (5 stories)

**Outcome:** A new user quickly sees trusted data, receives a bounded initial investigation, and keeps useful artifacts on one dashboard.

**Stories:** E07-S01 through E07-S05. Home is useful before AI completes; automatic analysis coalesces a batch and never reruns on every minor change. No multiple-dashboard framework or scheduled AI.

**Exit demonstration:** First batch import → partial trusted Home → evidence-backed analysis → saved tool → manual edit → pin → reopen → second import → live update. User layout changes survive personalization. Failure/Stop/retry remain understandable and keyboard-accessible.

## E08 — External-beta safety and product validation (8 stories)

**Outcome:** Demonstrate that the complete R1 is safe to operate for controlled external users and useful enough to justify expansion.

**Stories:** E08-S01, E08-S01b, E08-S01c, and E08-S02 through E08-S06. The original lifecycle story was split into export, deletion and retention so each can be reviewed separately. Privacy and security are implemented continuously; this epic closes and verifies lifecycle/operational obligations. No external financial-data cohort before all E08 lifecycle and S02–S05 gates pass and required processor/privacy arrangements are in place.

**Exit demonstration:** Export/delete/retention, isolated restore with deletion tombstones, production-provider policy, independent runtime/tenant review, bounded load/failure drills and full R1 acceptance pass. Founder records controlled-cohort results and go/iterate/no-go. Public launch still needs applicable legal/privacy/operational review and a release decision.

## R1 scope coverage

This maps every Delivery baseline row to its implementation owners. Story refinement must preserve coverage or explicitly update the product scope with the founder.

| Product baseline | Owning stories |
|---|---|
| CSV/XLSX, multi-account, automatic mapping + fallback, source history, duplicates | E02-S01–S07; E03-S01 for manual accounts/transactions/balances |
| Exact money, FX, transfer/refund, categories/tags, correction/audit/undo, coverage | E01-S04; E03-S01–S06 |
| Accounts, transaction table/filter/bulk edits, drawer, review, basic recurring | E02-S06; E03-S01, E03-S05–S08 |
| Persistent contextual chat, evidence/activity/Stop, initial Deep Analysis/findings | E04-S01–S07; E07-S01–S02 |
| Goals/virtual allocations, assumptions/daily cash, flat scenarios | E06-S01–S05 |
| Editable sandbox HTML/CSS/JS, live SDK/state, AI/manual edits, versions/revert/modes | E00-S02; E05-S01–S07 |
| One Home dashboard, trusted metrics, pin/unpin/reorder/limited sizes | E07-S02–S03 |
| Included AI, read-only prompts, usage/cost, account AI exclusions | E01-S05; E04-S01, E04-S03, E04-S06 |
| Navigation palette, job progress/completion, notices, evidence links | E01-S06; E02-S06; E04-S02–S04; E07-S04 |
| Auth/tenancy, export/delete, retention, restore, cost caps, redacted telemetry/security | E01-S02–S06; E04-S01/S03; E08-S01/S01b/S01c/S02–S05 |

R2/R3 are deliberately absent from the execution backlog. Create their epics only after R1 evidence supports the next investment. Do not interpret retained detailed target-product sections as an instruction to prebuild them.
