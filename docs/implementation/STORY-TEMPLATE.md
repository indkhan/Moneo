# Story template

Copy into the story's canonical entry in [STORIES.md](STORIES.md), or a linked story file when necessary. Replace every applicable field before Ready. Write “Not applicable — reason” rather than adding irrelevant work.

```markdown
## E##-S## — Observable outcome
Status: Draft | Release: R1 | Epic: E##
Dependencies: exact story IDs; no unresolved dependency on a future story

Outcome: Who can do what, and how we can observe it working.
Contracts: Product sections and architecture sections; existing domain/API references.
Scope: Smallest complete slice and expected modules/files, confirmed against current code.
Out of scope: Explicit adjacent features that must wait.

Acceptance:
1. Given [fixture/state], when [action], then [specific visible/stored result].
2. Given [failure/ambiguous input], then [error/review/recovery without lost data].
3. Given [unauthorized/concurrent/retried action], then [specified safe behavior].

Invariants: Exact-money, tenant, policy, evidence or runtime boundaries touched.
Failure lifecycle: Retry/idempotency, cancellation, concurrency and crash behavior.
UI/accessibility: Loading, empty, error, keyboard, responsive behavior as applicable.
Data changes: Migration, existing-data compatibility, deletion/retention and rollback.
Observability: Redacted signals and user-visible evidence; no secrets/financial payloads.
Limits: Fixture size, runtime/memory/cost constraints, quantitative pass threshold.
Verification: Exact commands and independent expected results; live-provider checks separate.
Review focus: Concrete ways to falsify this story's promises.
Rollout/rollback: Where enabled, release gate, reversibility and known limitations.

Execution record:
- Assignee / branch / worktree:
- Base SHA / implementation head SHA:
- Tests: commands, environment, exit codes, result links:
- Review: reviewer, reviewed SHA, findings, verdict:
- Integration: current main SHA, tested candidate SHA, checks:
- Merge SHA / post-merge smoke:
- Remaining blockers or explicitly accepted nonblocking follow-up:
```

Example acceptance: “Importing the same file twice creates no new canonical transactions; two identical rows in the original file retain their legitimate multiplicity.” This is better than “deduplication works.” Choose test values before implementing the algorithm.
