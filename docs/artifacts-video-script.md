# Moneo Artifacts: video script

A deep dive of about 9½ minutes for technical viewers and recruiters. You on camera, plus screen recording.

- **Screen A** is Moneo running at `http://localhost:3000`.
- **Screen B** is `docs/artifacts-deep-dive.html`, opened in a browser and full screen with `F`. Press `→` or click to reveal the next step. `←` steps back, `D` switches light and dark, and `R` hides the chapter rail. The scene numbers below match the rail.

Delivery: talk to one engineer you respect, not to a crowd. Short sentences, and pause after each reveal. Never read the slide aloud; say *why* it's there. The lines below are a guide, so say them in your own words.

---

## Before you record

- [ ] Rebuild and restart Moneo (`npm run build`, then `npm start`) so the fixes from this branch are live: no widget overlap while Home loads, and card previews at their real width.
- [ ] Home shows the three artifact cards: **Subscription radar**, **Scalable portfolio** and **Savings what-if**.
- [ ] Have one artifact chat ready to type into, so the opening shows a live build. The Savings what-if chat works: ask it for something small, like "add a line for a 3% return".
- [ ] Open the explainer in a second window or tab, already on scene 1.
- [ ] Close notifications. Zoom the browser to about 110% so text reads on YouTube.
- [ ] Your real balances and positions will be on screen. That's your choice; check nothing else in the sidebar or tabs is private.

---

## 0:00 – 1:00 · Cold open: the demo (Screen A)

**[Start on Moneo's Home, cards visible.]**

> This is Moneo, an open-source personal-finance app I built that runs on your own computer.
>
> Everything on this Home looks like part of the app. But three of these cards didn't exist in the code yesterday. This subscription radar, this Scalable portfolio card, this savings slider: I asked for them in plain English, and Moneo built them from my real data.

**[Drag the savings slider. The number and chart move instantly.]**

> That's not a screenshot. It's live. Drag it and it recalculates instantly, without a network request.

**[Click into the Scalable portfolio card → open its full page.]**

> Behind each card is a full page: charts, tables, my actual positions. Open it next month and it shows next month's numbers.

**[Go to the artifact chat, type a small change, press Enter. Let it build in the background.]**

> And you change it by asking. This runs on the server, so if I close this tab, it keeps going.

**[Back to Home.]**

> So: AI writes code that runs next to my bank data, and it looks like I wrote it. In the next eight minutes I'll show you how that works without trusting the AI with a single number, or with a single byte leaving this machine.

---

## 1:00 – 1:30 · Scenes 1–2: what an artifact is (Screen B)

**[Scene 1, title. Pause one beat.]**

> I call these artifacts. Quick stack: Next.js 16, React 19, Postgres, the Vercel AI SDK, and a JavaScript engine compiled to WebAssembly called QuickJS. You'll see why that last one matters.

**[Scene 2. → → → →]**

> An artifact is one chat, one full page, and any number of Home cards.
> **[→]** You describe it. The chat has the same read-only tools as Moneo's assistant.
> **[→]** It produces a page, real HTML and JavaScript…
> **[→]** …and cards that sit on Home next to the built-in widgets.
> **[→]** And the one rule behind all of it: the model writes the design, and the app supplies every number.

---

## 1:30 – 2:15 · Scene 3: why this is hard

> Generating a nice-looking page is the easy part. Doing it responsibly next to someone's money is hard for five reasons.

**[→ one per sentence]**

> **Correct:** money here is integer cents with a currency, and a model must never type an amount.
> **Current:** a page built today has to be right next month.
> **Safe:** the model reads my merchant names and notes, so text in a transaction could try to steer it. I treat everything it writes as hostile code.
> **Private:** Moneo is local-first. A generated page must have *no* path to send my data anywhere.
> **Native:** it has to feel like the app, not an iframe from 2009.

**[→ tagline]**

> Each of these became one layer of the architecture.

---

## 2:15 – 3:30 · Scene 4: architecture

> Two halves. The top half runs once, when you ask for a change. The bottom half runs every time you open it.

**[→ step 1]**

> I ask in the artifact's chat. The chat model reads my data with normal tools, then calls one of four tools: write a page, write a card, use a preset card, or remove a card.

**[→ step 2]**

> It doesn't write the code itself. It writes a *brief* with exact field paths, and a second model, the designer, writes the HTML or the React. The designer also gets a real sample of the data, so it designs for the true shape instead of guessing.

**[→ step 3]**

> Then there's a gate. The output has to parse, compile and render at every size with real data. If it fails, the errors go back to the designer, up to three tries. Nothing broken is ever saved.

**[→ step 4]**

> What gets saved is the code and the *queries*, as append-only versions. Never the numbers.

**[→ step 5]**

> Now the bottom half. Every time you open it, the query runner turns those saved queries into fresh data, with the same finance code as the rest of Moneo.

**[→ step 6]**

> A page goes into a double-sandboxed iframe…

**[→ step 7]**

> …and a card goes through a WebAssembly sandbox and is drawn by Moneo's own React.

**[→ step 8]**

> So the model runs once, and the data runs every time. That one idea solves *correct* and *current*.

---

## 3:30 – 4:30 · Scene 5: the data contract

> Let's zoom into that.

**[→ query JSON]**

> This is what's saved with a page: a name, a source, which is one of Moneo's read-only finance functions, and an input. The dates aren't dates. They're tokens.

**[→ timeline]**

> `@month_start` means November if I open it today and December if I open it in December. A month switch on a card is the same idea: a parameter that resolves into the query.

**[→ guardrails]**

> Some guardrails: if the model writes a literal date, the save is refused unless I asked for a fixed period, because a literal date freezes the page. Money arrives as exact minor-unit strings and the generated code uses BigInt, never parsing "€1,842.50" back into a float. And AI data scopes are checked again on every view, so if I turn off the AI's access to transactions in Settings, every artifact stops reading them.

**[→ MONEO_DATA, → tagline]**

> In the page it's just `window.MONEO_DATA`. The model owns the presentation, and Moneo owns the numbers.

---

## 4:30 – 5:20 · Scene 6: generate and verify

**[→ → →]**

> Two models, with a gate between them and your Home. Why two? The chat model keeps the conversation and the tools. The designer gets one focused job, a brief plus real data, and it writes better code that way.
>
> For a page, every inline script is compiled with Node's `vm.Script`. It's compiled, never run, so one syntax error can't leave a blank page. A card is checked harder: it's compiled, rendered at all four sizes, rendered again with every slider at its min and max and every switch flipped, and every control it declares must actually appear. Fail, and the exact errors go back to the designer.

**[→ durable, → races]**

> Two production details. Each request is a database row, and Next's `after()` keeps the run alive when you close the tab, so you come back to the result. And cancel really cancels: right before every write, the run checks it's still active, and version numbers are unique, so two parallel changes can't overwrite each other.

**[Optional, about 30 s, on camera: a real bug story]**

> A real example from preparing this video: I asked for a savings card, and it said "balances unavailable" while the page next to it showed my balance. The cause was that the designer's data sample was cut at 24,000 characters, and a 100-row transaction query came first, so the designer never saw what `balances` looks like and guessed the field names. The fix was to keep the first three items of every list in the sample, so every query's shape fits. Plus a test that fails on the old code.

---

## 5:20 – 6:30 · Scene 7: sandboxing a page

> This is the security part I'm proudest of.

**[→ → →, nesting appears]**

> A page is the model's HTML with my real data inside it. So the question is: how do you let code read your data but never send it anywhere?
>
> Three layers. The app embeds a frame route. That route's *response header* has a strict CSP and a sandbox. Inside it, the generated page is a second iframe with `srcdoc`, which gives it an opaque origin: no cookies, no storage, no access to the parent. It also gets its own CSP, with `default-src 'none'`.

**[→ → exits appear]**

> Now try to get data out. `fetch`, XHR, WebSockets: blocked. An image beacon with data in the URL: images only from `data:` and `blob:`. A script from a CDN: only inline, or Moneo's own `/artifact-lib/`. That's why ECharts is served from Moneo's `node_modules`, which also makes it work offline.

**[→ → → more exits]**

> Forms: `form-action 'none'`. Navigating somewhere with the data in the URL? That's the subtle one.

**[→ callout]**

> A page can't stop *itself* from navigating. Only the *parent's* `frame-src 'none'` can block the child frame from loading another URL. That's the whole reason the outer frame exists: it's there to hold that header.

---

## 6:30 – 7:20 · Scenes 8–9: cards are data, not DOM

**[Scene 8]**

> Pages are iframes. Cards can't be. Ten iframes on Home would be slow, couldn't use the app's components or theme, and would never look native.

**[→ → → → →]**

> So a card's code is a React component the designer writes. Sucrase compiles the JSX. It runs inside QuickJS compiled to WebAssembly, with a fresh runtime for every render, a 64 MB memory cap and a one-second deadline. It has no imports, no fetch and no timers. And the trick: it doesn't return DOM. It returns *JSON*, a tree of plain objects. `Kit.Money` is just the string `kit:Money`. Moneo's own React then draws that tree with its own components.

**[Scene 9, → → → →]**

> But the sandbox only stops code. The tree it returns is still untrusted, and a `url()` in CSS is a network request. So every node goes through an allowlist: known HTML and SVG elements only, no links, images or scripts; CSS parsed with PostCSS, scoped to the card, with `url()` and `@import` removed and backslashes refused so escape sequences can't spell them. Kit props are validated with strict Zod schemas. And again, errors go back to the designer before anything is saved.

---

## 7:20 – 8:00 · Scenes 10–11: controls and speed

**[Scene 10, → →]**

> Two kinds of controls. A month switch needs different data, so it asks the server and re-runs the query and the sandbox.
> A slider is just new maths on the same data, so the server ships the compiled code with the card, and the browser lazy-loads the *same* QuickJS and the *same* tree check and reruns it locally. That's why the slider in the opening was instant.

**[→ tagline, then scene 11, → → →]**

> And Home stays fast. Rendered trees are cached under a hash of the card version, params, size *and the data*, so a cache hit is never stale. Cards on one Home share their reads, so five cards that need balances query once. And every card streams in on its own: a slow Scalable call delays one card, and an error becomes a message in that card, never a broken Home.

---

## 8:00 – 8:30 · Scene 12: history and control

**[→ → →]**

> Moneo's rule is that the AI proposes and the owner decides. Every version is append-only. A new card is a *draft*: you preview it at each size and press Add to Home yourself, and Home never shows a draft. Delete and reset clean it all up, and there are tests for exactly that.

---

## 8:30 – 9:15 · Scene 13: decisions

> If you take one thing from this video, take the trade-offs.

**[→ seven times, one sentence per row]**

> Save queries, not numbers, so it stays current.
> Two models, because each does one job well.
> Verify before saving, so a working version is never replaced by a broken one.
> Two frames, because only a parent can stop navigation.
> JSON trees for cards, so they're native and cheap.
> QuickJS, because it gives real isolation and limits, and the same engine runs on the server and in the browser.
> Local ECharts, so it works offline and the policy can block every other origin.

---

## 9:15 – 9:40 · Scene 14: close

**[→]**

> Let the model design, and let the app own the truth.

**[→ →]**

> Moneo is open source, so the link is below. The two files I'd read first are `lib/ai/artifact-data.ts` for the sandbox and data contract, and `lib/cards/tree.ts` for the card check.
>
> If you're building anything where an AI writes code that touches real data, I'd love to hear how you're handling it. Thanks for watching.

---

## Description and chapters for YouTube

```
How Moneo lets an AI build pages and Home cards from your real finances, without trusting it with a single number or letting a byte leave your machine.

0:00 Demo
1:00 What an artifact is
1:30 Why this is hard
2:15 Architecture
3:30 The data contract
4:30 Generate and verify
5:20 Sandboxing a page
6:30 Cards are data, not DOM
7:20 Controls and speed
8:00 History and control
8:30 Decisions and trade-offs
9:15 Takeaway

Code: https://github.com/indkhan/Moneo
```

## If you need to cut time

Drop scene 11 (speed) and shorten scene 9 to one sentence: "the tree is checked against an allowlist before React sees it". That saves about 50 seconds.
