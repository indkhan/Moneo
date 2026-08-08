# Category plan prototype

- Requested: create an HTML page showing how Moneo's transaction categorization should work based on competitor research, then continue product planning.
- Done: added `extra/transaction-categorization-plan.html`, an interactive responsive brief covering competitor lessons, evidence flow, automatic-versus-review examples, correction rules, confidence behavior, and phased delivery; noted it in `application.md`.
- Approach: used a local, dependency-free HTML artifact so the proposed behavior can be reviewed before application code changes. The design emphasizes traceable evidence and preserves Moneo's calm visual language.
- Validation: `npm test` passed (38 tests); `npx tsc --noEmit` passed; HTML marker and `git diff --check` validation passed; browser QA covered desktop and mobile widths, interactions, overflow, and console warnings/errors.
- Remaining risks: categorization behavior is not implemented. Taxonomy customization and correction-rule defaults still need product decisions, and unresolved CSV reliability work remains the implementation gate.
