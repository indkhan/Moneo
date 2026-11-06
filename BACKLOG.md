# Backlog

## Self-hosted: phone access from anywhere
Open Moneo on your phone from any network, like T3 Code, with nothing to install on the phone. Moneo only listens on 127.0.0.1 today, and it signs its owner in automatically, so any remote access must add a login first (an `APP_PASSWORD` sign-in, or Cloudflare Access).
- Options weighed: Tailscale Funnel (free, fixed `*.ts.net` URL, nothing on the phone), Cloudflare Tunnel (free tunnel; a fixed URL needs your own domain, about $10/yr), or Tailscale with its phone app (private, no password needed).
- HTTPS is required for voice: browsers only give web pages the microphone over a secure connection.
- Callbacks: ChatGPT sign-in only accepts a 127.0.0.1 callback and Scalable's login accepts localhost freely, so both are connected from the computer Moneo runs on; their syncs then work from anywhere.

## Self-hosted: real banks need an HTTPS callback
Enable Banking production apps accept only `https://` redirect URLs, and Moneo runs on `http://localhost`. Sandbox apps (mock banks) work today. Options: a static HTTPS page (for example on GitHub Pages) that forwards `code` and `state` to `http://localhost:3000/api/bank/callback` in the owner's own browser, or serving Moneo on `https://localhost` if Enable Banking accepts it. The phone-access tunnel above would also provide an HTTPS address.

## Durable chat and artifact generation
Chat replies and artifact builds currently run inside the browser's API request, so navigating away or reloading can interrupt work before it is saved. Move generation into durable workflows, persist running/completed/failed state and results, and let the UI reconnect to progress and display finished results when the user returns. Preserve chat tool side effects and approval behavior; decide how to reconnect or replace live chat streaming.

## Multi-currency on Home
Home is built for one currency (the workspace display currency) for now.
- Recorded net worth by currency: Home used to list each currency's recorded total and the observations behind it (removed with the redesign; the Wealth page still shows net worth per currency).
- Net worth chart: plots only display-currency balances and valuations; convert others with the rate dated on or before each month end.
- Cash flow (month card and six-month chart): no "partial" marker when rows lack a rate; surface it again once FX is handled.
- Budgets and Coming up: amounts in other currencies are left out.

## Voice: later
The first version is the dictation mic, voice notes and live calls in chat, with every write still a card you tap. Left for later:
- Discreet mode: in public, say "it's on your screen" instead of reading amounts aloud.
- Show while talking: the call puts a chart or artifact on screen as it explains.
- Screen-aware calls: start a call from an artifact or Overview and ask about what's on screen.
- Offline voice notes: record without signal and send when back online; share-target and receipt photo plus voice in one note.
- Spoken daily brief: a short audio version of the agent briefing.
- Accept by voice: "yes, add it" accepts small cards (cash spends, IOUs); balances and recurring changes stay tap-only.
- ElevenLabs voices and separate speech-to-text and text-to-speech (any chat model in the middle) with the same call abilities: talk over it, several tasks at once, spoken progress. Gemini Live is another option behind the same call interface.
- Moving money: "send 20 to Ali" makes an IOU or reminder today; real bank payments are a separate, regulated feature.
- Phone-number calls (SIP) and a hands-free wake word.
- Push notifications when the app is closed (today the bell shows them on the next open).
- Locked-screen calls on iPhone: web apps lose the mic when the screen locks; needs a native wrapper.
- Cost limits: auto-hang on long silence, per-call and monthly caps, voice minutes on the usage page.
- Fully durable chat runs on Workflow if a turn ever needs longer than the function's max duration.
