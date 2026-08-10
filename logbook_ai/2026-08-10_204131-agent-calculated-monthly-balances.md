# Calculated monthly balances

- Requested: Treat complete account-history CSV imports as starting at zero, then show exact current and monthly balances throughout the dashboard.
- Done: Updated `src/lib/finance-summary.mjs` to roll booked transactions forward from €0 when source balances are absent, retain bank-provided balance anchors when present, and emit monthly closing points. Updated the dashboard/account UI in `src/components/finance-workspace.tsx`, tests, and `application.md`. This follows `2026-08-09_205440-agent-csv-monthly-balances.md`.
- Approach: Reused the existing summary and chart path with no new persistence or dependency. Pending and reverted transactions remain excluded; currencies remain separate; calculated values are explicitly labelled.
- Validation: TDD red run failed on four expected missing behaviors, then the focused suite passed 7/7. Full `npm test` passed 79/79 and `npx tsc --noEmit` passed. Expo web bundled and served HTTP 200. The supplied 156-row CSV produced €1,093.49 and 13 monthly values; desktop and 390px mobile browser checks had no page overflow, monthly selection worked, and the console was clean.
- Remaining risk: Calculated values are only accurate when the imported history is complete from the account's €0 opening state. Native Android/iOS visual QA was not run.
