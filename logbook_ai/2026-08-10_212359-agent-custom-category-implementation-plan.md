# Custom category implementation plan

- Requested: turn the agreed standalone-category and past-plus-future matching behavior into a step-by-step, commit-by-commit implementation plan.
- Done: mapped the feature onto the existing category-rule persistence, counterparty matcher, transaction UI, tests, and documentation. No product code was changed.
- Approach: keep custom category metadata on the existing reusable rule records, add pure searchable-catalog logic, then add one focused transaction modal; avoid a new IndexedDB store, dependency, category-management screen, or fuzzy/AI matcher.
- Validation: inspected `git status`, recent commits, package scripts, category call sites, and the current diff. Tests were not run because this was planning only.
- Remaining risk: existing uncommitted net-worth work overlaps `finance-workspace.tsx`, `application.md`, and `backlog.md`; separate it before category implementation.
