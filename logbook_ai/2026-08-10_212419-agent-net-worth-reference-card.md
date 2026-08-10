# Net-worth reference card

- Requested: Implement `extra/net-worth-reference-implementation-prompt.md` as focused commits.
- Done: Added a BigInt-safe month-over-month percentage helper and tests, then restyled the dashboard net-worth card in `src/components/finance-workspace.tsx` with the real latest-six-month series, exact per-currency headline, concise provenance, responsive guide-anchored tooltip, and quiet month axis. Updated `application.md` and removed the completed backlog item.
- Approach: Reused the existing balance series, chart helper, React Native SVG, and panel language; no dependency or architecture was added. The first currency remains the explicitly charted series and currencies are never combined.
- Validation: TDD red run failed on the missing percentage export, then passed. Final `npm test` passed 81/81 and `npx tsc --noEmit` passed. Expo web served HTTP 200; live empty and 13-month CSV states were checked at desktop and 390x844, including right-edge tooltip flipping, no horizontal overflow, and a clean browser console. Existing summary tests cover one-point and separate-currency series.
- Remaining risk: Native Android/iOS visual QA was not run; negative and flat chart behavior was verified through the pure chart/data paths rather than separate live imports.
