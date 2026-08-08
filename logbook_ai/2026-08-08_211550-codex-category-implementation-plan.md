# Category implementation plan

- Requested: produce the simplest clean implementation plan for local automatic transaction categorization.
- Done: added `extra/transaction-categorization-implementation-plan.md` with scope, import gate, minimal data model, deterministic classifier, persistence migration, correction behavior, tests, file changes, sequence, and ship gates; updated `application.md` and recorded deferred enhancements in `backlog.md`.
- Approach: limited v1 to one pure classifier module, one test file, one new IndexedDB store, fixed categories, and one counterparty-rule type. Avoided ML, dependencies, new routes, generic rule engines, and category-management architecture.
- Validation: verified required plan sections and ran `git diff --check`; documentation-only, so application tests were not rerun.
- Remaining risks: taxonomy customization remains a product decision. Category implementation must wait for the listed CSV reliability gate.
