---
name: verify-ui
description: Prove a Moneo change works by driving the real QA app the way the owner would, and attach the evidence (screenshots in light, dark and mobile, or a recording) to the pull request. Use after any change to a page, component, style or user flow, when asked to "verify", "show me it works" or "add screenshots", and before opening a PR that changes what the owner sees.
---

# Verify a change in the running app

The owner reviews what the app does, not the diff. "It compiles" and "the tests pass" are not proof; pictures and recordings of the real app are.

Everything here runs against the QA app on http://localhost:3100. Never use port 3000; that is the owner's app and data.

## 1. Launch

`npm run setup -- --qa`, then `npm run qa:auth`, then `npm run qa:server` in the background. It is ready when `curl -s -o /dev/null -w "%{http_code}" -H "x-moneo-test: 1" http://localhost:3100/api/health` prints 401 or 200.

If port 3100 is already taken, another checkout's QA app owns it and serves that checkout's code. Do not kill it. Start this checkout's app on a free port with `QA_PORT=<port> npm run qa:server` and point the tools at it with `E2E_BASE_URL=http://localhost:<port>`.

## 2. Doctor

Run this whenever anything looks off, before changing code:

`npm run qa:shots -- doctor home`

It fails with the reason when the app is not worth driving:

- **"The QA session was not accepted"**: the saved session expired (they last an hour). Run `npm run qa:auth`.
- **Every page is the "could not sign you in" screen after a fresh `qa:auth`**: the shared QA workspace holds data this checkout cannot read. Run `npm run qa:reset`.
- **A failed request or console error on an untouched page**: the base is broken. Fix or report that first; evidence taken on a broken base proves nothing.

## 3. Drive

1. **List the pages.** Every route the change can affect, including the ones AGENTS.md "Hit every surface" names. `FEATURES.md` shows a feature's pages, widgets, chat tools and voice routes together.
2. **Set up the state.** If a page needs data, create it the way the nearest spec in `e2e/` does. An empty page proves an empty page.
3. **Before.** With the change set aside (a temporary commit on another branch, or `git worktree add` of the base):
   `npm run qa:shots -- before home money/transactions`
   Name pages without the leading slash (Git Bash rewrites `/paths`); `home` is `/`.
4. **After.** On the changed code, the same command with `after`.

Each run writes `<page>-light.png`, `<page>-dark.png` and `<page>-mobile.png` to `.qa/shots/<label>/`, prints the HTTP status and every failed request or console error per page, and exits 1 if there were any.

**A flow, not a page.** A screenshot cannot show a tap, a card being accepted or an undo. Extend the journey spec in `e2e/` that already covers the flow and record it:

`npx playwright test e2e/<spec> --workers=1 --trace on --video on`

Add a new spec only when no existing journey can take the check (AGENTS.md Tests).

## 4. Evidence

- Use the path the owner uses: real pages, real buttons. Not a test-only endpoint or a direct database write for the step under test.
- Capture the action and the state it leaves, not only the last screen.
- Check the side effects next to what is visible: the row written, the history entry, what undo restores.
- **Look at every picture yourself.** Read each PNG. Check for overflow, clipped text, unreadable contrast in dark and a broken layout on mobile. A console error or a status of 400 or more is a failure: fix it and shoot again.
- When something looks wrong, suspect the capture before the app, and measure the live page before reporting a bug.

## 5. Hand over

The pictures go in the PR description itself, so the owner sees them on GitHub. A path to `.qa/` is not evidence: it is git-ignored and exists only on this machine. Never commit them to the PR's branch either.

1. Open the PR first to get its number.
2. Push the files to their own branch, `pr-assets/<pr>`, which holds nothing else. The repo is public, so QA data only:

   ```sh
   git worktree add --orphan -b pr-assets/<pr> .qa/pr-assets
   cp -r .qa/shots/before .qa/shots/after .qa/pr-assets/
   git -C .qa/pr-assets add -A
   git -C .qa/pr-assets commit -m "Screenshots for #<pr> (QA data)"
   git -C .qa/pr-assets push origin pr-assets/<pr>
   git worktree remove .qa/pr-assets
   ```

   To add more later, check the branch out again with `git worktree add .qa/pr-assets pr-assets/<pr>`.
3. Embed them with `gh pr edit <pr> --body-file <file>`, before and after side by side in a table, one row per page and view that visibly changed, with one line on what to look at:

   ```markdown
   | Before | After |
   | --- | --- |
   | ![Home, dark, before](https://raw.githubusercontent.com/indkhan/Moneo/pr-assets/<pr>/before/home-dark.png) | ![Home, dark, after](https://raw.githubusercontent.com/indkhan/Moneo/pr-assets/<pr>/after/home-dark.png) |
   ```

4. **A flow:** GitHub plays a GIF inline but not a video from a branch. If `ffmpeg` is installed, turn the recording into a GIF and embed it: `ffmpeg -i video.webm -vf "fps=10,scale=900:-1" flow.gif`. Otherwise embed a screenshot of each key state. Either way, push the recording too (`video.webm` from `test-results/`) and link it.
5. Open the PR on GitHub and check that every image shows.

Say which pages you covered, what changed in each and what you could not capture and why. If nothing visibly changed, say so and attach nothing.

## 6. Clean up

Stop only the server you started, found by its port and this checkout's path, never by name. Leave `.qa/shots/` in place: cleanup removes instances, never the evidence.
