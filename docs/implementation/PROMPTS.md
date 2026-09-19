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

## Run W1 / E01 after the passed W0 exit

```text
Act as the Moneo implementation orchestrator. Read AGENTS.md and every file in
docs/implementation required by README.md. Inspect Git and the canonical story
ledger before trusting status labels. Confirm the recorded W0 pass at merged
revision `b3e0280acfdd563a9d4211a0344b477dec977656`; if the tree or status has
changed, revalidate affected gates rather than reusing stale approval.

Execute all of W1/E01 in dependency order E01-S01 through
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
separate bounded live Keycloak/Docker deployment checks. Preserve exact decimal-string
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

## Run E04 end to end with Muse Spark 1.3

```text
Act as the Moneo E04 implementation orchestrator using Muse Spark 1.3. Continue
until E04 is genuinely Done or a material product/trust-boundary/access blocker
requires founder input. Do not stop after planning, scaffolding, one story, one
agent report, or a green unit suite.

First read AGENTS.md and docs/implementation/README.md, WORKFLOW.md, EPICS.md,
STORIES.md, E04.md and the referenced product/architecture sections. Inspect
Git, worktrees, running tasks and the actual committed tree. Preserve unrelated
work and never read, print, copy or commit secret values or customer data.

E03 is currently reopened. Before any E04 implementation, finish the recorded
E03-S02/S04/S08 remediation: build one tenant-scoped production calculation
boundary over canonical accepted imported/manual rows and persisted financial
semantics; keep native currencies separate; value each row before any base-
currency sum with explicit missing-FX coverage; compute and persist canonical
input/result SHA-256 evidence server-side; expose one production read used by
future tools; and replace hand-built TransactionLeg exit oracles with a real
import/command/query journey. Add failing regressions first, use real disposable
PostgreSQL, commit the candidate, delegate independent adversarial review to a
separate reviewer, fix findings, obtain re-review on the changed SHA, test the
latest-main candidate, merge, smoke, and update the ledger. Do not accept client-
supplied evidence hashes or mark E03 Done from existing green tests.

Once E03-S08 is genuinely Done, implement E04-S01 through E04-S07 strictly in
dependency order from E04.md. Use one short-lived story branch/worktree per
story. For every story: record base/assignee/status; implement the smallest
complete vertical slice; add risk-appropriate red/green checks; commit; assign
a separate non-editing reviewer the story/contracts/full diff and actual SHA;
fix every blocker and request re-review; construct and test the candidate against
latest main; merge only after current approval and required gates; run post-
merge smoke; then record commands/results/review/candidate/merge SHAs in the one
canonical STORIES.md ledger. Workers never merge main. Serialize shared schema,
policy, chat and worker contracts; do not run dependent stories in parallel.

Reuse existing tenancy, policy, command journal, durable jobs, recovery, money,
FX, evidence and shared-query code. Prefer PostgreSQL constraints/transactions,
Node built-ins and installed packages. Do not create a provider registry,
repository/service layer, workflow DSL, speculative package tree, custom model
picker, editable prompts, arbitrary SQL/network tools, external preview fetches,
or R2/R3 placeholders. Models never perform authoritative arithmetic, receive
SQL/credentials, expand their own capabilities, or assert user consent.

Muse Spark 1.3 is the requested development/live-evaluation candidate. Keep the
deterministic provider double in normal CI. Use the repository's existing
OpenRouter development mechanism only for the bounded synthetic live gate in
E04-S07; load the ignored local key through the documented native env-file path,
never expose its value, enforce the predeclared call/time/cost caps, and record
the exact provider model identifier returned/used. If Muse Spark 1.3 is missing,
renamed, unavailable, rate-limited or fails the frozen rubric, report that fact
and keep E04 blocked—do not silently substitute a model, relax thresholds, use
real financial data, or claim production qualification. Production remains
no-training/ZDR and is separately gated by E08-S03.

After S07, run the complete E04 exit on the merged revision: full deterministic
matrix, every E04 suite, E03 exit, builds, deliberate-failure nonzero gate,
staging smoke, diff/secret hygiene, and the integrated browser journey covering
send, durable worker recovery, scoped tools, exact evidence, reconnect, Stop,
retry, exclusion/revocation, usage accounting, hostile markdown and trusted
manual-transaction confirmation with replay/undo. Run the frozen live Muse Spark
1.3 evaluation separately. Record pass/fail honestly, including unavailable
live service. Mark E04 Done only when deterministic gates, independent review
and required live threshold evidence are current at the actual merged SHA.

Stop before E05. Do not deploy publicly or authorize real-customer use. Finish
with the E04 merge SHA, exact checks, live model identifier/result, limitations,
and the next dependency-ready story.
```

## Run W2 / E02 after the passed W1 exit

```text
Act as the Moneo implementation orchestrator and continue until W2/E02 is
genuinely complete or a material product/trust-boundary decision blocks it.
Do not stop merely after planning, scaffolding, one story, or an agent report.

Before changing code, read AGENTS.md and all implementation documents required
by docs/implementation/README.md. Read the Delivery baseline and the exact
architecture sections referenced by each E02 story. Inspect Git, worktrees,
running tasks, CI and the canonical STORIES.md ledger; verify the recorded E00/
E01 audit and W1 pass against actual SHAs and checks. Preserve unrelated work.
Never display, copy, commit or log `.env` values. The ignored local `.env`
contains the development OpenRouter key; when a bounded synthetic live gate is
required, load it with Node's native `--env-file=.env` mechanism and report only
pass/fail, request counts and non-sensitive metadata.

Implement E02-S01 through E02-S07 in dependency order. Use one short-lived
story branch/worktree per story and keep main deployable. S01, S02 and S04-S07
are Ready only when their dependencies are Done. S03 is Draft: before coding it,
refine its existing ledger entry by selecting maintained digest-pinned private
S3-compatible test storage and malware-scanner images, exercising them locally,
and recording the smallest privacy/maintenance rationale. Do not change the
production privacy boundary or mark S03 Ready from documentation alone.

For every story, follow this complete loop without waiting for routine approval:
1. Confirm dependencies and current main; record the base SHA and mark only that
   story In progress in the canonical ledger.
2. Trace the real callers and reuse existing E00/E01 code, migrations, command,
   tenancy, policy, parser and durable-job proof patterns. Build the smallest
   consumed vertical slice; prefer PostgreSQL constraints/transactions, Node
   built-ins and already-pinned packages. Do not create a generic workflow DSL,
   provider framework, repository layer, service tree, placeholder UI or R2/R3
   capability.
3. For nontrivial recovery, authorization, parsing, money or concurrency logic,
   first demonstrate a failing acceptance/regression check, then the passing
   implementation. Use real disposable PostgreSQL/Redis/object-store/scanner
   services where the story requires them. Mocks cannot prove transaction,
   fencing, RLS, queue-loss, quarantine or malware boundaries.
4. Commit the focused candidate and explicitly delegate independent adversarial
   review to a separate available agent/task. Give it the story, contracts,
   base/head SHAs, full diff and relevant callers. The reviewer must not edit
   what it approves. Implementer fixes findings, adds the smallest regression
   check, and requests re-review of the new SHA. Never self-approve or reuse an
   approval after the candidate changes.
5. Fetch latest main, construct and test the actual integration candidate, then
   merge only after required checks and current independent approval pass. Run
   post-merge smoke and update the story's single execution record with actual
   commands, exit codes, SHAs, review verdict, CI link, merge and remaining
   limitations. A skipped/live-unavailable check is not a pass.
6. Continue immediately to the next dependency-ready E02 story. If a gate fails,
   diagnose and fix its root cause before dependent work. After two failed
   fix/review cycles, split or replan the story in the same ledger instead of
   weakening acceptance or looping blindly.

Preserve these non-negotiable boundaries throughout W2:
- PostgreSQL is durable truth; BullMQ is at-least-once transport. Accepted work,
  outbox state, immutable results, attempt generations, checkpoints and fencing
  must make duplicate delivery, worker death and complete Redis loss converge
  without duplicate business effects.
- Enforce membership, explicit workspace predicates, composite tenant keys and
  FORCE RLS at every HTTP, worker, reconciliation and shared-function boundary.
  Tenant-owned and nonexistent IDs must not become distinguishable or leak data.
- Money stays exact; models never authorize or calculate canonical money. Raw
  files/rows, secrets and excluded accounts never enter Redis, logs or model
  context outside the story's minimum explicitly permitted synthetic sample.
- Quarantine bytes are private and never directly served. Scanner/parser workers
  receive no DB/model credentials. Signature, size, archive, formula, external
  link, macro, bomb, timeout, memory and process-death cases fail closed.
- Deterministic mapping comes first. OpenRouter is bounded assistance with a
  strict schema, reservation, policy-version checks and validated output; outage,
  malformed output or exclusion must leave the manual path usable.
- Reimport/dedup preserves legitimate identical purchases and provenance. Fuzzy
  date/amount/description equality is never identity. Staged/rejected ambiguity
  never enters accepted totals.
- Keep the server-rendered UI keyboard usable, labelled, responsive at 320 px,
  explicit about errors/progress/cancel/retry, and durable across refresh/login.

At E02-S07, run the actual W2 exit demonstration on the merged candidate: first
and overlapping second synthetic CSV/XLSX imports; exact canonical, multiplicity,
provenance and review counts from an independent oracle; worker death at each
checkpoint; Redis loss; cancel/retry; hostile and unsupported uploads; two-tenant
ID swaps; browser keyboard/320 px journey; scanner/storage integration; full W1
critical regression; deliberate-failure gate; configured staging smoke; diff and
tracked-secret hygiene. Measure the declared 1-row, 10-file and 100k-row/resource
limits rather than inventing an SLA. Record the final merged SHA, environment,
commands, durations and independent review in STORIES.md.

Stop only after W2 is recorded Pass, or with one precise blocker that truly
requires founder input. Do not begin E03, use real customer financial data,
enable public ingestion, deploy publicly, or silently relax a failed gate.
Your final response must state: integrated SHA, stories completed, exact checks
and CI results, live-provider status, remaining limitations, and next eligible
story. Claims without repository evidence do not count.
```
