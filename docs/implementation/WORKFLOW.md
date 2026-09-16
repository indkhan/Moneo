# Delivery workflow

## Shape of the work

Prefer a vertical slice: the smallest observable outcome including needed schema, domain function, API/tool, UI and tests. Infrastructure proofs may be technical stories with an explicit runnable result. Add only the layers the story actually needs. A whole import system or whole artifact runtime is too large for one PR.

Normally one story means one short-lived branch and PR from current main. Aim for one focused implementation/review cycle and roughly 100–400 handwritten changed lines where practical; neither time nor line count is a rule. Generated code, fixtures and migrations are inspected according to risk, not excluded from review. Split when unrelated behavior, several contracts, extensive context or independently releasable changes accumulate. A ten-line tenant check can need more review than a large presentation change.

Keep main deployable. Incomplete behavior must be inaccessible or honestly marked as unavailable; use a small feature flag only where needed. Avoid long-lived epic branches and a permanent development branch. Dependent PR stacks are an exception: explicitly track their base and revalidate after the parent merges.

Start with at most two simultaneous implementation stories, only with stable contracts and non-overlapping ownership. The orchestrator alone integrates. Shared schema/API/runtime changes are serialized unless their interfaces are agreed first. Do not create additional services or a bespoke multi-agent system merely to run this workflow.

## Roles and authority

| Role | Responsibility |
|---|---|
| Founder/product owner | Resolves genuinely ambiguous product choices, approves material scope/trust-boundary changes, and decides public release. |
| Orchestrator | Refines stories, orders dependencies, assigns ownership, records state, verifies evidence and merges eligible changes within granted repository authority. |
| Implementer | Implements the assigned scope, writes relevant tests, runs them, fixes review findings and reports exact evidence. |
| Independent reviewer | Reads the specification and actual diff, attempts to falsify acceptance/security claims, reports concrete findings and a verdict. Does not modify the candidate under review. |

Use a separate reviewer context/task. It may use the same model; using another model can diversify scrutiny but is not proof of independence or correctness. The reviewer gets the story, contracts and diff, not just the implementer's persuasive summary. Additional specialist review is justified for money, tenancy, artifact isolation or destructive lifecycle changes. Do not require several reviewers on every routine edit.

The implementer fixes findings. If a reviewer authors a patch, another reviewer must assess that patch. The orchestrator cannot count an implementer's self-review as independent approval. If independent review is unavailable, report Awaiting review; do not invent a pass.

## Story state and merge gate

`Draft → Ready → In progress → In review → Changes requested → In review → Approved → Integrated → Done`

Changes requested is optional. Blocked may occur at any stage; retain the previous state and reason. Rejected means the proposed approach needs redesign, not necessarily abandoning the user outcome. Skipped tests and unavailable credentials are visible limitations, not passes.

1. **Ready:** Define outcome, exclusions, contract references, dependencies, example acceptance cases, risk-specific tests, operational limits and migration/rollback implications. No unresolved decision that changes implementation semantics. Future discovery is allowed only when explicitly the purpose of a proof story.
2. **Assign:** Confirm dependencies Done, inspect current main and local instructions, create a story worktree/branch (`story/e00-s01-proof-harness` pattern), and record its base SHA. Preserve unrelated work. With no initial repository, E00-S01 creates a local baseline first; never overwrite an existing history.
3. **Implement:** Build the smallest complete slice. Add a failing regression/acceptance check before nontrivial money/security/recovery logic where practical, then demonstrate it passing. Inspect real callers and reuse shared functions. No generic infrastructure for deferred features.
4. **Review:** Record `base_sha`, `head_sha` and merge-base; review the entire PR diff plus relevant callers/configuration/migrations. Test acceptance against the spec, not only the implementation's own tests. Findings cite file/line, impact, evidence or reproducible scenario, severity and a proposed direction. Suspicion may request investigation; a preference alone does not block.
5. **Fix:** Implementer addresses blockers with regression tests where appropriate. Reviewer checks the new head and affected paths. Approval is tied to the reviewed SHA; any candidate change requires explicit revalidation, proportionate to the changed risk. Do not hold unrelated nits hostage.
6. **Integrate:** Fetch current main; create the intended merge/rebase/squash candidate in isolation and test that combined tree. Record current main SHA and candidate SHA. Conflicts or semantic changes return to review. If main advances before integration, recompute and rerun affected integration gates; never claim old-base tests validate the new combination. Use repository protection/merge queue when available, otherwise serialize manually. Equivalent final trees still need traceable candidate-to-merge evidence.
7. **Merge and verify:** Only after blockers are closed, independent review is current, required tests pass and rollback is understood. Apply migrations in a safe order. Run the appropriate post-merge smoke in local/synthetic staging, record merge SHA, then mark Done. Failed smoke pauses dependent merges; revert or forward-fix based on data safety. Do not blindly reverse a destructive migration.

Review verdicts: **Pass**, **Changes requested**, **Blocked** (cannot verify), or **Reject approach** (violates the intended contract or needs fundamental redesign). Blocking defects include wrong financial values, unauthorized access, data loss, broken acceptance, unsafe execution and nonrecoverable accepted jobs. Lesser reproducible defects may also block according to user impact. Nonblocking cleanup is recorded explicitly, not disguised as a security requirement. After two unsuccessful fix/review cycles, the orchestrator diagnoses scope or design and splits/replans; it does not automatically accept, endlessly retry, or delete failing tests.

## Tests proportional to the risk

| Layer | What it must demonstrate |
|---|---|
| Unit/golden fixtures | Exact amounts, sign/direction, currency exponents, dates, FX rounding, transfer/refund semantics, projections and capability validation. Expected values are independently calculated. |
| Integration | Real PostgreSQL constraints/RLS and transaction behavior; Redis transport and PG recovery; idempotency, racing writes, leases and stale-attempt fencing. Mock tests cannot substitute here. |
| Browser/system | Critical upload/review/chat/artifact/pin/reopen/second-import journeys, keyboard/error/loading behavior and supported-browser sandbox behavior. A small critical suite, not every interaction repeated end-to-end. |
| Adversarial | Cross-tenant IDs, parser resource attacks, prompt injection, excluded data, forged actions, XSS/network/navigation attempts, runaway code and stale grants. |
| AI evaluation | Versioned synthetic cases for mapping, grounded claims, tool selection, abstention and artifact edits. Deterministic protocol tests in normal CI; bounded live-model qualification separately. A provider outage is not a code-test pass or failure. |
| Operations | Worker/process death, total queue loss, cancellation, migration/deploy rollback, backup restoration, deletion tombstones, performance and cost limits. |

Each story names the required subset. Do not demand unit + integration + E2E for every styling/documentation edit, write tests mirroring implementation, or use coverage percentage as a substitute for behavior. Comments explain non-obvious constraints and decisions; there is no comment quota.

E00-S01 establishes actual runnable commands; later stories add only needed commands. Never paste an invented `pnpm test:*` command as completed evidence. Record command, environment, commit, exit status and meaningful result. Local synthetic credentials/test services are separate from real users. Live free-model tests use synthetic data by default and bounded calls; production qualification separately enforces no-training/ZDR routing. Do not log sensitive payloads.

At every epic exit, run its integrated demonstration against the merged code. At every wave exit, rerun affected earlier critical journeys. This catches stories that pass individually but fail together. External financial-data beta requires all E08 safety/operational gates; public launch additionally requires the founder's release decision and applicable privacy/legal review.

## Refinement and change control

Detail only the next wave. For each Draft story, inspect the actual code, set module ownership, exact test commands, synthetic fixtures, limits and observable acceptance thresholds, then mark Ready. Implementation may tighten the decomposition; preserve scope traceability when splitting/merging stories. For large uncertainty write a time-bounded proof with a specific decision and stop condition instead of speculative architecture.

If a desired simplification changes the financial, privacy or artifact security contract, propose and record the change in the authoritative plan before dependent work. Routine implementation choices need no new founder approval. If blocked by credentials, external access or a material product ambiguity, report the smallest missing input and continue independent authorized work.

Keep one backlog. Use PR/CI links for evidence. Add a short decision record to the affected story when a proof changes a technology choice; create a separate ADR only when its lifetime and complexity justify it. Do not create a parallel status database.

## Basis

This is a project-specific process, informed by [Google's small-change guidance](https://google.github.io/eng-practices/review/developer/small-cls.html), its [review standard](https://google.github.io/eng-practices/review/reviewer/standard.html), and [DORA's trunk-based development guidance](https://dora.dev/capabilities/trunk-based-development/). The story counts, two-story concurrency cap and review-cycle escalation rule are initial project choices, not claims made by those sources.
