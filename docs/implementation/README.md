# R1 implementation plan

**Planning baseline:** 2026-09-16. No application implementation or feasibility proof is complete merely because these documents exist.

Start here. The [product specification](../ai_native_personal_finance_product_spec_v7.md) owns release scope; the [architecture](../personal_finance_technical_architecture_v11.md) owns technical contracts. This directory owns execution order, story status, delivery gates and reusable agent prompts. If they conflict, record and resolve the conflict before implementing the affected behavior. Do not silently weaken an invariant to finish a story.

## Read and use

1. Read [workflow](WORKFLOW.md) once and use its gates on every change.
2. Read [epics and waves](EPICS.md) for ordering and release coverage.
3. Choose the next dependency-ready entry in [stories](STORIES.md). That file is the authoritative story/status ledger.
4. Use [prompts](PROMPTS.md) to assign, implement, review, fix and integrate it.
5. Refine later stories with the [story template](STORY-TEMPLATE.md) immediately before their wave. Keep their existing IDs; split with suffixes if necessary and update dependencies.

There are **9 epics and 56 initial stories**. This is an initial decomposition, not a quota or a delivery estimate. E00's five stories are specified for the first wave; all subsequent stories start Draft. Ready means specified, not that dependencies have already passed. Select only Ready stories whose dependencies are Done. Record refinements inline in STORIES.md; use a separate story file only when it improves readability and replace the inline entry with a link, not a competing copy.

An **epic** is an integrated outcome. “Epoch” means the same thing in this project. A **story** is one reviewable change and normally one PR. A **wave** groups work that can proceed at a similar stage; it creates no extra branches, tickets or approval layer.

## Start now

Assign **E00-S01** with the Start prompt. It establishes the minimal executable proof harness, actual verification commands, and repository baseline if needed. Run E00-S02 through E00-S05 as dependencies permit, with at most two implementation stories in flight. Stop dependent work when a feasibility gate fails; document the evidence and smallest safe alternative before choosing it.

Do not build the complete schema, every package in the architecture, a custom orchestrator product, or R2/R3 placeholders. Existing agent/task tools plus Git, CI and this ledger are sufficient. Initial infrastructure is provisioned only by the story that exercises it.

## Durable execution record

Update each story's status and evidence in STORIES.md, preferably in its PR. After integration the orchestrator records the merge SHA and wave result in a small documentation update. Preserve useful evidence through links to PR/CI artifacts rather than copying logs into the backlog. Never include financial data, credentials or raw provider prompts containing personal data.

For every started story record: assignee/role, branch or worktree, base SHA, implementation SHA, reviewer result and reviewed SHA, candidate test SHA, test commands/results, blocking findings, and merged SHA. No Git/CI system currently exists is implied; E00-S01 establishes local Git and E01-S01 establishes CI. A missing remote blocks remote PR evidence, not local proof work; report that limitation honestly.

No story is Done based on an agent's message alone. The orchestrator verifies the committed tree, independent review, tests of the integrated candidate, and merge evidence. A wave closes only when its integrated exit demonstration passes.
