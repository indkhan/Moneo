---
name: verify-ui
description: Capture before and after screenshots of Moneo pages in light, dark and mobile from the QA app, and attach them to the pull request. Use after any change to a page, component or style, when asked to "verify the UI", "show me it works" or "add screenshots", and before opening a PR that changes what the owner sees.
---

# Verify a UI change

The owner reviews what the app does, not the diff. Give them pictures of every page the change touches.

Everything here runs against the QA app on http://localhost:3100. Never use port 3000; that is the owner's app and data.

## Steps

1. **List the pages.** Work out every route the change can affect, including the ones AGENTS.md "Hit every surface" names (home widgets, the chat panel, mobile layout).
2. **Get the QA app running** if it is not: `npm run setup -- --qa`, `npm run qa:auth`, then `npm run qa:server` in the background. If a page needs data, create it the way the nearest spec in `e2e/` does.
3. **Before.** With the change set aside (a temporary commit on another branch, or `git worktree add` of the base), run:
   `npm run qa:shots -- before home money/transactions`
   Name pages without the leading slash (Git Bash rewrites `/paths`); `home` is `/`.
4. **After.** On the changed code, run the same command with `after`.
   Each run writes `<page>-light.png`, `<page>-dark.png` and `<page>-mobile.png` to `.qa/shots/<label>/`. It prints the HTTP status and any browser console errors per page and exits 1 if there were any.
5. **Look at every picture yourself.** Read each PNG. Check for overflow, clipped text, unreadable contrast in dark, and a broken layout on mobile. A console error or a status of 400 or more is a failure: fix it and shoot again.
6. **Show the owner.** Put before and after side by side in the PR description for each page that visibly changed, and say in one line what to look at. Upload the images by dragging them into the PR on GitHub, or ask the owner to if you cannot; `.qa/` is git-ignored, so never commit them.

## When the change is a flow, not a page

A screenshot cannot show a click, a card being accepted or an undo. Extend the journey spec in `e2e/` that already covers the flow and run it with a recording:

`npx playwright test e2e/<spec> --workers=1 --trace on --video on`

Attach the video from `test-results/`. Add a new spec only when no existing journey can take the check (AGENTS.md Tests).

## Report

Say which pages you shot, what changed in each, and anything you could not capture and why. If nothing visibly changed, say so and attach nothing.
