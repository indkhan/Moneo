---
name: measure-speed
description: Measure how fast Moneo opens and how fast the changed action runs, before and after a change, and put the numbers in the pull request. Use before opening any PR that changes code, when asked "is it faster", "measure speed" or "check performance", and when a change could slow a page, an import, a sync, a chat answer or start-up.
---

# Measure speed before and after

Every change should leave Moneo as fast as before or faster. Measure it; never guess. A PR that only changes docs (`*.md`, `docs/`) skips this and writes "No runtime change" under Speed.

Everything runs against the QA backend, never port 3000, on production builds: `next dev` compiles each page on its first visit and makes everything look slow.

## 1. Two builds

- **After:** this checkout. `QA_PORT=3101 npm run qa:server -- --production` in the background.
- **Before:** the PR's base in its own worktree: `git worktree add ../moneo-speed-base origin/main`, then in it `npm ci`, `npm run setup -- --qa` (copies `.env.qa`) and `QA_PORT=3102 npm run qa:server -- --production` in the background.

Both use the same QA workspace, so they see the same data. Each is ready when `curl -s -o /dev/null -w "%{http_code}" -H "x-moneo-test: 1" http://localhost:<port>/api/health` prints 401 or 200. Run `npm run qa:auth` if the session is older than an hour.

Set up the data the change needs the way the nearest spec in `e2e/` does, through the app. An empty page measures an empty page.

## 2. Opening the app

`node scripts/perf-pages.mjs 5 before=http://localhost:3102 after=http://localhost:3101`

It loads every main page cold on desktop and mobile, the two builds interleaved run by run so machine noise hits both alike, and prints the medians: TTFB, first paint, LCP, time until the heading shows, layout shift, long tasks and JS KB. The full results are in `.qa/perf-before.json` and `.qa/perf-after.json`.

## 3. What the change touches

Time the action the change affects, from the owner's tap until its result shows: opening a panel, an import, accepting a card, a sync, a chat answer. Use Playwright against both ports, one warm-up and then at least 5 runs each, and take the median.

Mock AI, bank and Scalable with `page.route`, the way `e2e/*.mocked.spec.ts` does, so nothing costs money and the number is Moneo's own time, not the provider's. `scripts/perf-interactions.mjs` makes real AI calls: run it only when the owner asks.

For work with no screen (a workflow step, a `lib/` function), time it with a small script against the QA backend, both checkouts, same runs and median.

## 4. Read the numbers

A slowdown is a median more than 10% **and** more than 50 ms worse, or more JS on a page. Anything smaller is noise; when in doubt, run again.

A slowdown means this change made Moneo slower. Find the cause (a trace with `--trace on`, the Network tab, the React Profiler) and fix it before opening the PR, then measure again. If the extra time cannot be avoided, say in the PR what costs it and why, and ask the owner.

## 5. Hand over

Add this to the PR description:

```markdown
## Speed

Production builds on QA data, median of 5 runs. Before: `<base sha>`. After: `<head sha>`.

| What | Before | After | Change |
| --- | --- | --- | --- |
| Open Home, desktop (heading shows) | 640 ms | 610 ms | −5% |
| Open Home, mobile | 820 ms | 800 ms | −2% |
| Accept a cash card (tap → new balance) | 310 ms | 290 ms | −6% |
```

List Home, every page the change touches and the action from step 3. Put any slowdown first, with its cause.

## 6. Clean up

Stop only the servers you started, found by port and checkout path, never by name. Remove the base worktree with `git worktree remove ../moneo-speed-base`.
