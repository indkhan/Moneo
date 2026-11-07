# Backlog

## In-app service keys: follow-ups
Keys for OpenAI, OpenRouter and Enable Banking are entered in the app (Settings → AI access, Import → Connected banks) and sealed in `service_keys`.
- Optional one-click "Move to the app" that copies a key still in `.env` into the database; today the `.env` value is used until a key is saved in the app, and nothing is removed from `.env`.
- Enable Banking's `GET /application` response may list the registered redirect URLs; warn on save when `https://localhost:3443/api/bank/callback` is missing instead of waiting for `REDIRECT_URI_NOT_ALLOWED`.
- `scripts/voice-call-check.mjs` still reads `OPENAI_API_KEY` from the environment.
- Keys are cached for 5 seconds per process; a second server process sees a change within that time.

## Self-hosted: phone access from anywhere
Open Moneo on your phone from any network, like T3 Code, with nothing to install on the phone. Moneo only listens on 127.0.0.1 today, and it signs its owner in automatically, so any remote access must add a login first (an `APP_PASSWORD` sign-in, or Cloudflare Access).
- Options weighed: Tailscale Funnel (free, fixed `*.ts.net` URL, nothing on the phone), Cloudflare Tunnel (free tunnel; a fixed URL needs your own domain, about $10/yr), or Tailscale with its phone app (private, no password needed).
- HTTPS is required for voice: browsers only give web pages the microphone over a secure connection.
- Bank connections from the phone: register the tunnel's `https://…/api/bank/callback` as a second redirect URL in Enable Banking, and send the bank back to whichever address the owner started from (laptop: `https://localhost:3443`).
- Callbacks: ChatGPT sign-in only accepts a 127.0.0.1 callback and Scalable's login accepts localhost freely, so both are connected from the computer Moneo runs on; their syncs then work from anywhere.

## Multi-currency on Home
Home is built for one currency (the workspace display currency) for now.
- Recorded net worth by currency: Home used to list each currency's recorded total and the observations behind it (removed with the redesign; the Wealth page still shows net worth per currency).
- Net worth chart: plots only display-currency balances and valuations; convert others with the rate dated on or before each month end.
- Cash flow (month card and six-month chart): no "partial" marker when rows lack a rate; surface it again once FX is handled.
- Budgets and Coming up: amounts in other currencies are left out.
