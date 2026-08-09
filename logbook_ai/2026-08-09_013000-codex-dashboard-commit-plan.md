# Dashboard commit plan

- Requested: Produce a commit-by-commit plan that requires a web check before every commit.
- Done: Added `extra/dashboard-reference-implementation-plan.md`, linked it from `application.md`, and recorded unsupported follow-up product slices in `backlog.md`. No application code was changed.
- Approach: Split visual parity into six small commits, reuse the recoverable `800852e` visuals, preserve current CSV/category work, and require desktop/mobile browser inspection plus tests and TypeScript before each commit.
- Assumptions and tradeoffs: Visual parity means matching hierarchy and styling while using real imported data or explicit unavailable states; mock identity, financial values, and AI claims will not be restored.
- Validation: Reviewed the plan against the current finance data types/provider, summary helpers, current dashboard component, and the earlier reference implementation. Tests and TypeScript were not run because only documentation changed.
- Follow-up: Execute the six commits in order; budget persistence, recurring detection, safe-to-spend, AI, notifications, settings, investments, and pinning remain separate vertical slices.
