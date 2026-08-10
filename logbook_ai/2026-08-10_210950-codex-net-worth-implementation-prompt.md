# Net-worth implementation prompt

- Requested: Create a complete prompt-plan for making the current net-worth card match the supplied target in the simplest way.
- Done: Added `extra/net-worth-reference-implementation-prompt.md`, a copy-paste implementation prompt covering the minimal file scope, reference composition, truthful financial states, responsive behavior, tests, and visual validation. Linked it from `application.md`.
- Approach: Direct the implementer to reuse the earlier reference structure from commit `800852e` and the current CSV-backed series instead of adding a dependency, chart library, or new architecture. The frontend-design guidance set the visual hierarchy; the ponytail guidance constrained the plan to the smallest local diff.
- Validation: Reviewed the generated prompt and repository diff. Runtime tests were not run because no runtime code changed.
- Remaining follow-up: Execute the prompt, compare desktop and mobile screenshots, and remove the completed backlog item after implementation.
