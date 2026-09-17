# Reusable implementation prompts

Use the **Start** prompt once, then **Continue** for routine progress. The orchestrator uses the role prompts internally. Replace story IDs and commit placeholders with actual values. These prompts authorize local implementation/review/testing and local integration of eligible changes; pushing/merging to a remote follows your granted repository permissions. They do not authorize public release, production-data experiments or spending outside configured project limits.

The repository [AGENTS.md](../../AGENTS.md), [workflow](WORKFLOW.md), [story ledger](STORIES.md) and authoritative product/architecture contracts remain the source of truth. Prompts are instructions to verify evidence, not claims that tests, independent agents, credentials or remote services are already available.

## Start — first implementation session

```text
Act as the Moneo implementation orchestrator. Read AGENTS.md and
docs/implementation/README.md, WORKFLOW.md, EPICS.md and STORIES.md.
Read the product Delivery baseline and the architecture sections referenced by
the assigned story. We are building R1 only, with editable sandboxed HTML/CSS/JS.

Start with E00-S01. Inspect the real repository, instructions, installed tools
and Git state first. Preserve unrelated work and never expose or commit .env
or credentials. If no Git repository exists, establish the local main baseline
as specified in the story, then use a story branch/worktree.

Implement the smallest complete story and execute its acceptance checks.
Use a separate independent reviewer agent/task if available; explicitly delegate
the adversarial review of the committed diff and relevant callers/contracts.
The implementer fixes findings, and the reviewer rechecks the updated SHA.
You own dependency decisions and integration; workers must not merge main.

Only integrate after blockers are closed, independent review is current and
checks pass on the candidate combined with current main. Record actual SHAs,
commands/results, review verdict, merge and smoke evidence in STORIES.md.
If independent review or required access is unavailable, report the exact
blocker and leave the story unmerged rather than inventing a pass.

Finish this story, then report what passed, what remains unproven and the next
eligible story. Do not begin R2/R3 or expose the application to real customers.
Do not ask permission for ordinary authorized implementation choices; ask only
when a material product/trust-boundary decision or required missing access
prevents correct progress.
```

## Continue — everyday prompt

```text
Continue Moneo using AGENTS.md and docs/implementation/README.md.
Read the story ledger and inspect actual Git/PR/CI state; do not trust status
labels or previous agent summaries without evidence. Resume unfinished work
before starting another story. Choose the next dependency-ready story in the
current wave. If it is Draft, refine it against the actual code and template
before marking Ready; do not silently change product scope or safety contracts.

Complete one story through implementation, risk-appropriate tests, a separately
delegated independent adversarial review, implementer fixes, re-review of the
current SHA, and checks of the integrated candidate against latest main.
Merge only within granted repository authority and after all gates pass.
Run the post-merge smoke and update the canonical ledger with evidence.
At an epic/wave boundary run its integrated exit demonstration as well.

Keep the change small; reuse existing functions and native/platform features.
No speculative scaffolding, test/comment quotas or deferred-feature placeholders.
Never treat mocked provider checks as live qualification or skipped checks as
passes. If blocked, record the precise cause and progress independent authorized
work where possible. End with the result, remaining blockers and next story ID.
```

## Continue a wave — longer autonomous run

```text
Use the same rules as the Continue prompt, but complete the remaining eligible
stories in wave [W0] and stop at its exit gate. Refine Draft stories before
assignment. Use at most two implementation agents concurrently, only for
dependency-independent work with non-overlapping ownership. You may delegate
implementation and independent review to separate agents; serialize integration.
Each story gets its own review and latest-main candidate checks before merge.

Keep durable state in STORIES.md and use PR/CI links for evidence. Do not start
the next wave, weaken a failed gate, or loop through repeated review failures.
After two failed fix/review cycles, diagnose and replan the approach. Report
material product/access blockers with the smallest question needed and continue
other eligible work. At wave completion run and report its integrated demo;
do not claim completion merely because all agents stopped running.
```

## Refine — orchestrator prepares a later story

```text
Refine [STORY_ID] in docs/implementation/STORIES.md using STORY-TEMPLATE.md.
Inspect the implementation and all prerequisite evidence first. Preserve its
outcome and the authoritative R1 scope/contracts. Define concrete example
acceptance, expected modules/interfaces, authorization/invariants, failure,
retry/cancel/concurrency behavior, UI states, migrations/rollback, redacted
telemetry, synthetic datasets, numerical limits and exact runnable checks.

Keep one observable outcome and one reviewable PR. If too large, split into
bounded suffixed IDs and update all dependencies and coverage references.
No speculative package/service layer. A proof story must name its decision,
finite experiment and stop condition. Record genuinely unresolved decisions;
mark Ready only when an implementer can proceed without guessing semantics.
Do not implement product code during this refinement assignment.
```

## Implement — one worker, one story

```text
Implement [STORY_ID] on [BRANCH/WORKTREE], based on [BASE_SHA].
Read AGENTS.md, the story, its product/architecture references and relevant
existing callers. Verify prerequisites. Own only the assigned scope; coordinate
shared schema/API changes with the orchestrator before editing.

Build the smallest complete slice. Reuse shared domain functions for UI, AI,
worker and artifact paths; do not reimplement money or authorization in adapters.
Add meaningful acceptance/regression checks for the risk and run them. For
nontrivial financial/security/recovery logic, demonstrate a failing check then
the passing implementation where practical. Test real transactional behavior
with actual PostgreSQL/Redis when the contract requires it.

Keep synthetic data and secrets out of committed logs. Do not weaken acceptance,
skip a failing required check, invent command results, or broaden to R2/R3.
Document an actual blocker and complete independent in-scope work if possible.
Commit the reviewable change when ready. Report the head SHA, changed behavior,
exact test commands/results and remaining risks. Do not approve your own work
or merge main; hand the candidate to the independent reviewer/orchestrator.
```

## Review — independent adversarial assessment

```text
Independently review [STORY_ID] from [BASE_SHA] to [HEAD_SHA].
Read AGENTS.md, WORKFLOW.md, the story's acceptance and authoritative contracts
before the implementer's summary. Verify the SHAs/merge-base, inspect the full
diff and relevant surrounding callers, schema, configuration and deployment
effects. Compare behavior with the requested specification, not just main's
existing behavior or the new tests. Do not edit the candidate.

Try to falsify the story's promises. Prioritize exact money and coverage,
tenant/policy isolation, concurrency/idempotency, cancellation/recovery, evidence
reproducibility, artifact capabilities and actual user acceptance where relevant.
Run available checks and add independent temporary probes without modifying the
reviewed tree; distinguish confirmed defects from unverified concerns. Test
expected outcomes independently of the implementation's own algorithm.

Return Pass, Changes requested, Blocked, or Reject approach, bound to HEAD_SHA.
For each actionable finding give severity, file/line, concrete impact, a repro
or supporting evidence, violated acceptance/contract and smallest correction
direction. Separate blockers from nonblocking suggestions. No invented issues,
style-only blockers, generic checklists or claim that no findings proves safety.
List exactly what you ran, what you could not verify and any required specialist
review. Do not merge or silently fix the code you are approving.
```

## Fix — implementer addresses review

```text
Address the independent findings for [STORY_ID] at [HEAD_SHA].
Confirm each finding against the contract and actual callers. Fix the root cause
in the shared path, add a reproducing regression check where appropriate, and
rerun affected gates. Do not remove tests, relax security/financial acceptance,
or sneak unrelated cleanup into the patch. If a finding is mistaken, provide
concrete counter-evidence for the reviewer rather than ignoring it.

Return each finding's disposition, new head SHA, exact checks/results and any
remaining blocker. Request independent re-review of the updated candidate.
Do not treat the previous SHA's approval as covering this patch or merge main.
```

## Integrate — orchestrator verifies and merges

```text
Evaluate [STORY_ID] for integration. Verify dependencies, recorded acceptance,
current reviewed SHA, reviewer independence, closed blockers and actual test
evidence. Inspect current main and the intended integration method. Construct
the combined merge/rebase/squash candidate in isolation and execute required
checks against that candidate, including affected prior critical journeys.

Record main SHA and tested candidate SHA. If main advances, rebuild/revalidate
the relevant combination. Conflicts or semantic edits require renewed review;
do not reuse stale approval. Confirm migration rollout/rollback and make sure
no secrets/unrelated changes enter the candidate.

Merge only within granted repository authority and after gates pass. Run the
post-merge smoke, record merge SHA and evidence in STORIES.md, and mark Done
only after success. If smoke fails, pause dependent merges and use a safe revert
or forward fix; never blindly reverse destructive data changes. If credentials,
remote permissions or independent review are missing, report the blocker and
leave the candidate unmerged. Do not publicly deploy as part of this prompt.
```

## Epic/wave exit — verify the assembled product

```text
Verify exit criteria for [EPIC/WAVE_ID] from docs/implementation/EPICS.md against
the merged implementation. Trace every required outcome to completed story
evidence and run the integrated demonstration plus affected earlier critical
journeys. Verify money, authorization, failure and unsupported-input behavior
as well as the happy path. Record exact revision, commands, dataset/environment
and results; separate live-provider availability from deterministic correctness.

If a gate fails, open a bounded corrective story with dependencies and acceptance;
do not declare the wave complete, silently reduce its scope or start dependent
work. Preserve useful proof results and retire discarded experimental code.
Return pass/block with evidence, known limitations and the next eligible work.
External beta and public launch must satisfy the distinct E08 gates.
```

## Resume after an interruption

```text
Recover Moneo's actual state using AGENTS.md, STORIES.md and Git/PR/CI evidence.
Inspect dirty worktrees and running agents/jobs without overwriting them. Find
the last verified implementation/review/integration SHAs, distinguish committed
work from unverified reports, and resume the earliest unfinished gate. Do not
reimplement a completed story, reuse approval after a changed candidate, or
mark a test passed from memory. Continue one story under the normal workflow
and update the durable record with any recovered evidence or blocker.
```

## Finish W0 audit, then run W1

```text
Act as the Moneo implementation orchestrator. Read AGENTS.md and every file in
docs/implementation required by README.md. Inspect Git and the canonical story
ledger before trusting status labels. Start from the W0 exit audit recorded on
2026-09-17; do not start E01 while any reopened E00 dependency is incomplete.

Close E00-S03, E00-S04 and E00-S05 through the normal workflow. For S03 add the
missing independently expected fee/refund, missing-balance and FX-gap proof
cases required by architecture §540. For S04 use real child-process termination
at the specified persisted boundaries against real disposable PostgreSQL and
Redis, proving recovery and stale-attempt fencing. For S05 run the bounded live
Auth0, Render-to-AWS OIDC and development OpenRouter probes; skipped live gates
remain Blocked. Never print or commit credentials. If the required founder
accounts, plan choices or credentials are absent, record the exact blocker,
finish other authorized corrections, and stop before E01.

For each correction: use a short-lived branch/worktree, add the smallest
risk-specific check, commit, delegate independent adversarial review to a
separate agent/task, fix findings, obtain re-review on the new SHA, test a
latest-main integration candidate, merge only after all gates pass, run the
post-merge smoke, and update STORIES.md with actual SHAs and results. Then run
and record the complete W0 exit demonstration. Do not treat prior approval as
covering new commits.

Only after W0 passes, execute all of W1/E01 in dependency order E01-S01 through
E01-S06. Before assigning each Draft story, refine its canonical STORIES.md
entry with STORY-TEMPLATE.md against the then-current code and authoritative
product/architecture contracts; mark Ready only when implementation semantics,
limits, migrations/rollback and exact runnable checks are resolved. Complete
each story through implementation, risk-appropriate tests, separately delegated
independent review, fixes/re-review, latest-main candidate checks, merge and
post-merge smoke. Keep at most two dependency-independent implementations in
flight; E01's current dependency chain will normally make this one at a time.

Build the smallest consumed vertical slice. Reuse the proven E00 code where it
fits; do not create the full conceptual package tree, generic command framework,
blank services, staff console or R2/R3 placeholders. Use real PostgreSQL for
tenant/RLS/transaction guarantees, deterministic synthetic fixtures in CI, and
separate bounded live Auth0/deployment checks. Preserve exact decimal-string
money and versions at JSON boundaries, deny tenant/policy access at every trust
boundary, keep secrets and financial payloads out of logs/artifacts, and never
weaken a failed gate to continue.

At W1 completion run its EPICS.md exit demonstration at the merged revision:
two synthetic users sign in and create isolated workspaces; tenant-swapped IDs
fail in API and real database tests; revoked sessions fail on API and reconnect;
an optimistic conflict is visible; no privileged worker bypasses isolation; and
the same critical smoke passes locally, in CI and in synthetic staging. Record
revision, environment, commands and results in STORIES.md. Stop at the W1 gate;
do not begin E02, use real customer financial data, or publicly release.
```
