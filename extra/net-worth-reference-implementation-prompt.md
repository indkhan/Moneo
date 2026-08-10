# Net-worth reference implementation prompt

Copy and execute the prompt below from the Moneo repository root.

---

You are working in `C:\codebases\Moneo`.

## Objective

Restyle only the dashboard net-worth card so it closely matches the supplied target screenshot while preserving Moneo's real CSV-backed financial data and existing responsive dashboard.

- Current screenshot: `C:\Users\mgsuk\AppData\Local\Temp\codex-clipboard-ad2a7938-3c2e-4126-973f-ee9b5a7e25c0.png`
- Target screenshot: `C:\Users\mgsuk\AppData\Local\Temp\codex-clipboard-4c19c8f5-bd86-4e97-8754-27b41693e52b.png`

The target is the second image: a compact pale hero, one strong net-worth value, a real month-over-month badge, a spacious six-month line/area chart, one selected-point tooltip with a vertical guide, and quiet month labels. The current balance pills and detached selection caption must go.

## Non-negotiable product rules

- Read `AGENTS.md` and `application.md` before editing.
- Inspect the current implementation before changing it.
- Use commit `800852e` only as a visual source for the old `NetWorth` component and its styles. Do not revert, cherry-pick, or restore its mock data.
- Keep all values derived from the existing `balanceSeriesByCurrency(data.transactions)` result.
- Never combine unlike currencies or invent conversion rates, balances, percentages, or history.
- Keep calculated-versus-source-backed provenance visible, but shorten it so it does not dominate the hero.
- Preserve the desktop breakpoint at `>= 1024px`, the dashboard grid, and the mobile stack.
- Do not add a dependency, new component architecture, chart library, animation system, or generalized design-token layer.
- Do not change unrelated cards, routes, import behavior, transaction data, or mock values elsewhere.
- Do not commit unless explicitly requested. If later asked to commit, use the user's configured Git identity.

## Smallest implementation

Touch only these runtime files unless a discovered correctness issue makes another file unavoidable:

- `src/components/finance-workspace.tsx`
- `src/lib/net-worth-chart.ts`
- `src/lib/net-worth-chart.mjs`
- `src/lib/net-worth-chart.test.mjs`

### 1. Build the chart model from real data

Inside `NetWorth`, keep `balanceSeriesByCurrency` as the source of truth.

- Use the first currency series as the displayed chart, as the current implementation does.
- Use only its latest six monthly closing points for the chart and month axis. Do not discard history from storage or from the headline calculation.
- The headline always displays the latest point in the complete series, not the currently selected tooltip point.
- Format chart labels as short month names such as `Mar`, `Apr`, and `May`. Keep full month/year and exact amount in accessibility labels where useful.
- Default the selected point to the second visible month when at least two points exist. This keeps the tooltip in the same calm, left-of-centre position as the target. Clamp selection safely when the number of visible points changes.

Add only one small pure helper if needed: a BigInt-safe month-over-month percentage calculation returning tenths of a percent. It must:

- Compare the latest two points in the same currency.
- Return no value when fewer than two points exist or the previous value is zero.
- Round to one decimal place.
- Support positive and negative changes.

Do not convert minor-unit balances through floating point merely to calculate the percentage.

### 2. Match the target hero

Use the earlier reference implementation as the baseline, then tune against the target screenshot.

- Keep the card border radius, border, and shadow from the existing Moneo panel language.
- Give the hero approximately `28–30px` horizontal padding and enough vertical padding for a total hero height close to `136px` on desktop.
- Keep `NET WORTH` as an uppercase, spaced, muted kicker.
- Render the primary value at approximately `38–42px`, weight `800`, dark ink, with tight negative letter spacing.
- For EUR, present the existing exact localized amount with a leading `€` rather than a trailing `EUR`. Do not change the shared formatter globally. Other currencies must remain explicitly labelled.
- Put the real percentage badge and `vs. last month` on the same baseline as the value when space permits. Use a pale green positive badge and pale red negative badge.
- For calculated data, use concise provenance such as `Calculated from imported history · No currency conversion`. For source-backed data, use `Source-backed monthly balances`. If multiple currencies exist, state that currencies are shown separately.
- Use a restrained mint-to-ice wash like the target. The simplest cross-platform option is an absolutely positioned SVG rectangle/gradient using the already-installed `react-native-svg`; do not install a gradient package. A solid pale mint is acceptable only if visual comparison shows no meaningful loss.
- When multiple currencies exist, keep their values visibly separate. The single-currency state should match the target most closely.

### 3. Restore the reference chart composition

Reuse the old chart structure from commit `800852e`, wired to the real visible points.

- Chart plot height: approximately `180px` on desktop.
- Horizontal plot inset: approximately `20px`.
- Thin teal line with the existing subtle teal-to-transparent area fill.
- Add the SVG vertical guide line at the selected point.
- Keep the selected dot teal with a white outline.
- Restore the white floating tooltip containing the selected month and exact formatted balance.
- Position the tooltip from the selected point and flip it to the left when the point is near the right edge so it never clips.
- Keep the tooltip inside the top and horizontal bounds of the card.
- Preserve transparent hit regions over each point. Update selection on desktop hover and on press/tap. Add `accessibilityState={{ selected: ... }}` and useful labels.
- Do not add animation; the target's calmness comes from spacing and precision.

### 4. Replace the crowded footer

Delete the current detached `chartSelection` text and horizontally scrolling month-balance pills.

Replace them with one non-scrolling month axis below the chart:

- Six evenly spaced short month labels.
- Muted utility text, about `11px`.
- Approximately `20px` horizontal padding and `15–20px` bottom padding.
- No chip backgrounds, borders, or visible monetary values in the axis.

The desktop card should land close to the target's overall height of roughly `370px` and should not grow merely because the imported history contains many months.

### 5. Preserve honest edge states

- No series: keep the existing honest import-history empty state.
- One point: show one centred point without an area polygon, percentage, or invented trend.
- Flat series: render a stable horizontal line.
- Negative balances: render and format them correctly.
- Multiple currencies: never add them; show them separately and chart only the explicitly labelled primary series.
- Long history: show only the latest six months in the chart.
- Narrow/mobile layout: reduce the value and tooltip only as necessary, keep all content inside the card, and keep month labels readable at `390px` without horizontal scrolling.

## Visual target

Aim for this hierarchy:

```text
┌──────────────────────────────────────────────────────────┐
│ NET WORTH                                                │
│ €1.093,49   +5.7%   vs. last month                       │
│ Calculated from imported history · No currency conversion│
├──────────────────────────────────────────────────────────┤
│                 ┌────────────────┐                       │
│                 │ Apr            │                       │
│                 │ Net worth: ... │                       │
│       rising/falling line and soft area fill              │
│                 │ guide                                  │
│   Mar          Apr       May       Jun       Jul      Aug │
└──────────────────────────────────────────────────────────┘
```

The signature element is the selected-month tooltip anchored to the thin guide line. Everything else should remain quiet.

## Tests

Extend the existing chart-helper tests only where behavior is non-trivial. Cover:

- Empty and single-point chart safety.
- Six-point windowing if implemented in the helper rather than inline.
- Positive and negative percentage rounding.
- Zero previous balance returning no percentage.

Do not build a broad component-testing setup for this change.

## Validation loop

1. Run `npm test`.
2. Run `npx tsc --noEmit`.
3. Run `npm run web`.
4. Inspect the card against both supplied screenshots at desktop size and at `390x844` mobile size.
5. Verify no horizontal overflow, tooltip clipping, console errors, or dashboard-layout regressions.
6. Check at least these data states: empty, one point, more than six months, flat/negative values, and multiple currencies.
7. Iterate on spacing, font sizes, tooltip placement, chart height, and label alignment until the card visibly matches the target rather than merely containing the same elements.

Before finishing:

- Run `npm test` and `npx tsc --noEmit` again and report their exact results.
- Update `application.md` in one concise bullet.
- Remove the completed net-worth-restyle item from `backlog.md`.
- Add one new append-only logbook entry in `logbook_ai/` following `AGENTS.md`.
- Review `git diff` and ensure only directly related changes remain.

## Definition of done

- At first glance, the card has the same composition, visual density, hierarchy, tooltip treatment, and month-axis simplicity as the target screenshot.
- Every displayed amount and percentage is derived from imported data and reconciles with the existing balance series.
- The card stays compact regardless of history length.
- Desktop and mobile have no clipping or overflow.
- Empty and multi-currency states remain truthful.
- Tests and TypeScript pass.

---
