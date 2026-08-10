# Custom transaction categories

- Requested: implement standalone custom categories from `Needs category`, reusing existing behavior, commit by commit in a worktree.
- Done: added searchable built-in/custom category catalog helpers; persisted custom labels on existing counterparty rules; made `Needs category` open the existing inline editor; added search, exact duplicate reuse, custom creation, affected-transaction count, saving/error states, and past-plus-future rule application. Updated `application.md` and `backlog.md`.
- Approach: reused `categoryRules`, `counterpartyKeyFor`, and `applyCategoryRule`; no new store, migration, dependency, modal, or category-management screen. Custom categories receive opaque local IDs and labels remain on reusable rules.
- Validation: Node tests, TypeScript, and responsive web verification performed in the `C:\codebases\Moneo-custom-categories` worktree; see task handoff for final results.
- Remaining risk: similarity is intentionally lexical (normalized exact, prefix, and substring matching), not semantic synonym detection.
