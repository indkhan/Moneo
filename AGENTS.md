# Moneo agent instructions

## Scope and authority

Read [implementation start](docs/implementation/README.md) and the assigned entry in [story ledger](docs/implementation/STORIES.md) before implementation. The [product Delivery baseline](docs/ai_native_personal_finance_product_spec_v7.md) owns release scope; the [architecture](docs/personal_finance_technical_architecture_v11.md) owns contracts; [workflow](docs/implementation/WORKFLOW.md) owns delivery gates. R1 comes first. Older V1/MVP language is not authorization for R2/R3 work.

Use the smallest complete slice. Reuse existing code, standard libraries and platform features before dependencies/abstractions. No unused package trees, services, placeholder features or custom orchestration platform. Do not simplify away financial correctness, security, durability or accessibility.

## Execution

- Implement only the assigned dependency-ready story in a short-lived branch/worktree. Preserve unrelated local work. If the repository has no Git history, follow E00-S01's baseline bootstrap before story branching.
- Follow the workflow's implement → test → independent review → implementer fixes → re-review → latest-main candidate checks → merge → smoke sequence. Reviewers do not silently edit the code they approve. The orchestrator integrates; worker agents do not merge main.
- During implementation, the orchestrator should explicitly delegate independent review to a separate available agent/task. If unavailable, record Awaiting review; never substitute self-approval. No subagents are required merely to read or edit planning documents.
- Approval and checks bind to actual commit SHAs. Changed candidates require revalidation; stale-main testing is not proof of integration. Never mark Done from an agent's assertion alone.
- Refine Draft stories before implementing them. Update the single canonical ledger with real commands/results, SHA/review/merge evidence and blockers. Do not maintain a second competing backlog.
- Tests follow risk: exact-money goldens; real DB/queue integration for transactional guarantees; critical browser journeys; hostile runtime/tenant checks. Do not add every test layer or comments by quota.
- No application/package scripts are assumed to exist. E00-S01 establishes actual commands; run and report them truthfully. Do not claim unrun or skipped checks passed.

## Data and boundaries

- Never print, commit or copy `.env`/credentials into docs, prompts, logs or fixtures. Use synthetic financial data by default. Do not run destructive fault tests against shared/production services.
- Development OpenRouter free/training-permitted routes are separate from production no-training/ZDR policy. No real-customer use before the E08 gates, no silent privacy downgrade and no fake live-model qualification.
- Money uses exact representations; authorization/policy applies at every shared function and trust boundary. Models never get raw SQL. Artifacts never receive unrestricted DOM/network/host credentials. Durable effects require idempotency and fencing.
- Routine implementation choices do not need repeated permission. Material product/trust-boundary changes and missing required access must be surfaced. Public release requires a separate founder decision.

Reusable prompts: [PROMPTS.md](docs/implementation/PROMPTS.md). Do not begin implementation merely because a planning task created this file.
