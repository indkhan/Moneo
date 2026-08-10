# Net-worth chart alignment fix

- Requested: Plan first, then fix the inconsistent month-to-guide alignment and visually verify every month.
- Done: Changed `chartPoints` to use the same equal-cell centres as the month labels, added a regression test, and updated `NetWorth` with a fixed 8px marker, rounded non-scaling line/guide strokes, quieter bounded fill, and focus-driven selection. Updated `application.md` and removed the completed backlog item. This follows `2026-08-10_213008-agent-net-worth-chart-geometry-diagnosis.md`.
- Approach: Reused the existing six-cell label and hit-target layout as the single x-coordinate source; no measurement state, chart dependency, or smoothing curve was added.
- Validation: TDD red run failed on two-point and six-point endpoint spacing, then the focused suite passed 5/5. Final `npm test` passed 82/82, `npx tsc --noEmit` passed, and Expo web returned HTTP 200. Live checks selected all six months at desktop and 390px: worst guide-to-label difference was 0.004px desktop and 0.013px mobile, dot size stayed 8x8, screenshots had no overflow, and both consoles were clean.
- Remaining risk: Android/iOS visual QA was not run.
