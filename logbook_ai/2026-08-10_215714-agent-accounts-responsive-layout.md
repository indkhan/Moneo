# Accounts responsive layout

- Requested: Diagnose and fix the dashboard Accounts section breaking at intermediate viewport sizes.
- Done: Kept the dashboard breakpoint and full-screen row intact, but stacked each account's balance beneath its identity from 1024–1399px. Added a tested responsive predicate, passed the real viewport width separately from the hydration-safe width, and updated `application.md`.
- Why: Populated account rows forced icon, identity, and balance/status/date into a dashboard rail as narrow as 178px. A local compact row fixes the constraint without changing other dashboard cards or mobile layout.
- Validation: `npm test` passed 86 tests; `npx tsc --noEmit` passed; Expo web was checked with populated local data at 1000, 1024, 1200, 1399, 1400, and 1440px with zero horizontal overflow.
- Remaining risk: The 1400px cutoff is tied to the current sidebar, content maximum, panel padding, and 2:1 dashboard grid proportions.
