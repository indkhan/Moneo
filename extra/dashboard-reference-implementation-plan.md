# Dashboard reference implementation plan

## Goal

Restore the supplied dashboard's desktop composition and visual hierarchy while preserving Moneo's real CSV-backed data, mobile layout, and explicit unavailable states. Do not restore the old mock identity, balances, budgets, recurring payments, investment values, or AI claims.

Use commit `800852e` only as a visual source. Do not revert the repository or replace the current import, persistence, categorisation, or transaction-detail work.

## Rule before every commit

The commit sequence is always:

1. Implement only that commit's slice.
2. Run `npm test` and `npx tsc --noEmit`.
3. Run `npm run web` and inspect the changed flow in the browser.
4. Capture and compare desktop (1990x847) and mobile (390x844) views. Check empty data and, when relevant, imported data.
5. Check the browser console for new errors and test navigation at both widths.
6. Fix any discrepancy before committing. Never make the commit first and verify afterward.

Before the first commit, verify that Git's configured `user.name` and `user.email` are the user's identity. Do not override the author.

## Commit 1 — `refactor(ui): restore the reference dashboard shell`

Scope:

- Restore the reference header proportions, content alignment, sidebar spacing, active navigation treatment, shadows, borders, and card tokens in `src/components/finance-workspace.tsx`.
- Restore the greeting/date hierarchy, compact search-shaped control, notification-shaped control, and avatar-shaped local profile affordance.
- Keep the Moneo name. Do not invent a person's name or claim that search, notifications, or settings work; unavailable controls must be visibly disabled or route to an honest unavailable state.
- Restore the safe-to-spend-shaped sidebar surface as an explicit unavailable state until its calculation exists.
- Preserve the existing `>=1024px` desktop breakpoint and mobile bottom navigation.

Web acceptance before commit:

- At 1990x847, sidebar width, header height, content start, and utility controls visually align with the reference.
- At 390x844, no horizontal overflow exists and bottom navigation remains usable.
- Existing routes still navigate.

## Commit 2 — `feat(dashboard): restore the reference card composition`

Scope:

- Replace the current `Cash flow + Transactions + Accounts` dashboard composition with the reference hierarchy:
  - main: net worth hero;
  - main split: spending and budgets;
  - main lower: transactions;
  - right rail: AI insight, accounts, and recurring.
- Reuse the earlier component shapes from `800852e`, but initially render truthful loading, empty, unavailable, and error states.
- Show the CSV import action only when the dashboard has no imported transactions; keep it compact so it does not displace the dashboard hierarchy.
- Do not change the dedicated Transactions, Budgets, Investments, Recurring, or AI routes in this commit.

Web acceptance before commit:

- Desktop card order, relative widths, gaps, heights, and rail structure match the reference.
- Mobile cards become one readable stack in priority order.
- With an empty database, every card explains what is missing and gives only a real action.

## Commit 3 — `feat(dashboard): connect accounts and net worth to imported balances`

Scope:

- Restyle the current real account rows to match the reference account rail.
- Add a pure, tested balance-series helper in `src/lib/` using `balanceAfterMinor` snapshots.
- Calculate net worth separately per currency; never silently add unlike currencies or invent exchange rates.
- Restore the SVG line/area chart using `react-native-svg`, including accessible labels and a simple selected-point interaction where supported.
- If balance history is insufficient, show the latest traceable balance or the honest empty state instead of manufacturing a trend.

Web acceptance before commit:

- Test with no accounts, an account without source balances, one-currency balances, and multiple currencies.
- Values on the card reconcile with the imported account rows.
- Chart remains clipped inside its card at both target widths.

## Commit 4 — `feat(dashboard): connect spending and recent transactions`

Scope:

- Add a pure, tested monthly category summary using booked transactions and the existing Moneo category assignments.
- Restore the spending donut and legend using real category totals; uncategorised spending remains explicitly labelled.
- Restyle the existing recent transaction list to the compact reference presentation while retaining source detail and category editing when a row is opened.
- Derive the displayed period from available transaction dates instead of hard-coding August.

Web acceptance before commit:

- Verify empty, categorised, uncategorised, mixed-sign, and multiple-currency datasets.
- Donut totals reconcile exactly with visible category amounts.
- Transaction rows do not collide with amounts at mobile width.

## Commit 5 — `feat(dashboard): add honest budget recurring and AI states`

Scope:

- Finish the budget, recurring, and AI cards in the reference visual language.
- Budgets: show progress only if a real persisted budget model exists; otherwise show “No budgets set” and route to the current honest Budgets state.
- Recurring: show detected commitments only after a separate tested detector exists; otherwise show “Detection not available”.
- AI insight: show a connected insight only after consent, privacy, loading, empty, and error flows exist; until then clearly state that AI is not connected.
- Keep unavailable cards visually complete without fabricating financial content.

Web acceptance before commit:

- Each CTA routes correctly and never implies an unsupported integration works.
- Loading, empty, unavailable, and error copy fits without changing card geometry unexpectedly.
- Keyboard focus is visible on web.

## Commit 6 — `fix(dashboard): complete responsive visual parity`

Scope:

- Perform the final screenshot comparison against the supplied reference.
- Correct only measurable differences in spacing, typography, card dimensions, radii, shadows, chart proportions, and responsive ordering.
- Check desktop widths immediately above and below 1024px, plus 390px mobile.
- Update `application.md` concisely and add the required append-only logbook entry.
- Remove only temporary artifacts created during this work.

Web acceptance before commit:

- Desktop matches the reference's composition and visual density without fake data.
- Mobile has no clipping, overlap, inaccessible action, or hidden content.
- Empty and imported-data screenshots are retained only as local verification artifacts unless explicitly requested for the repository.
- `npm test` and `npx tsc --noEmit` pass immediately before the final commit.

## Later feature commits, outside visual parity

These should remain separate vertical slices because the current repository does not support them:

- Persisted budget creation and editing, followed by real dashboard budget progress.
- Conservative recurring-payment detection with review and confidence evidence.
- Traceable safe-to-spend calculation with a displayed formula and per-currency result.
- AI integration with consent, privacy, loading, empty, and error states.
- Notifications, working settings, investment holdings/prices, and dashboard pinning.

