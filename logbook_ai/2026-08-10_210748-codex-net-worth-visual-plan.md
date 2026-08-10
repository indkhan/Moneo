# Net-worth visual plan

- Requested: Compare the current net-worth card with the supplied target and plan the work needed to match it.
- Done: Inspected both screenshots, the current `NetWorth` component and chart helper/tests, the earlier reference implementation in commit `800852e`, `application.md`, and relevant logbook context. Added the deferred visual-restoration slice to `backlog.md`; no runtime code was changed.
- Approach: Reuse the earlier reference card's tooltip, guide, labels, and proportions, but keep the newer CSV-backed series, exact per-currency values, and explicit provenance. Plan for a bounded recent-month window, truthful month-over-month change, and desktop/mobile variants.
- Validation: Repository inspection only; tests and Expo were not run because no runtime behavior changed.
- Remaining follow-up: Implement and visually compare the card at desktop and mobile widths, including empty, single-point, long-history, negative/flat series, and multiple-currency states.
