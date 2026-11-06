# Moneo

Moneo is an open-source personal finance workspace you run on your own computer. Import statements or sync your bank, track accounts and wealth, plan spending, and ask questions about your money in chat or on a voice call. Financial figures always come from your own records; the AI explains them and proposes changes you accept.

It is a Next.js and TypeScript app. The backend (Postgres plus the open-source Supabase Auth, PostgREST and Storage services) runs in Docker on your machine. There are no accounts and no sign-in screen: one owner, one workspace, and everything stays on `127.0.0.1`.

## Run it

You need [Node.js](https://nodejs.org) 22+ and [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on Windows and macOS).

```sh
npm ci
npm run setup              # creates .env with fresh secrets, starts the database, applies migrations
npm run build && npm start # then open http://localhost:3000
```

`npm run setup` is safe to rerun. Run it again after every `git pull` to apply new migrations; your data and secrets are kept. For development, use `npm run dev` instead of build and start.

The database keeps running in Docker after you stop Moneo (`docker compose stop` stops it, `docker compose up -d` starts it again). Your data lives in Docker volumes `moneo_db-data` and `moneo_storage-data`; `docker compose down` keeps them, `docker compose down -v` deletes them.

Everything listens on `127.0.0.1` only, so other devices on your network cannot open Moneo. Keep `.env` private: it holds the database password and the keys that sign the owner in.

## AI

Settings → **AI access** offers two equal options, and you choose which one pays:

- **ChatGPT plan**: click **Sign in with ChatGPT** and allow plan usage. Requests count toward your Go, Plus or Pro plan's limits.
- **OpenAI API key**: set `OPENAI_API_KEY` in `.env` and restart Moneo. Usage is billed to that key.

Voice calls and dictation need the API key, because ChatGPT plan usage doesn't support audio. Models are chosen per agent under Settings → AI and your data; IDs with a `/` (for example `vendor/model`) go to OpenRouter and need `OPENROUTER_API_KEY`.

## Background jobs

While Moneo runs, it checks hourly for scheduled summaries, review recovery, bank sync and Scalable Capital sync. Each sync runs about once a day, and anything missed while the computer was off runs shortly after Moneo starts.

## Scalable Capital (optional)

First turn on access in Scalable on the web under Profile → Security → Agentic Investing (read-only is enough). Then Settings → **Connect Scalable Capital** opens Scalable's login (with 2FA in the Scalable app). Moneo then reads your holdings, totals and cash daily as wealth records. It uses Scalable's official read-only MCP server and needs no keys.

## Connect your bank (optional)

Moneo can sync booked transactions and balances from EU banks (for example Revolut and Commerzbank) through [Enable Banking](https://enablebanking.com). Its restricted mode is free for personal use and covers the accounts you link yourself. Each sync is written as an ordinary import, so it shows in import history and can be reviewed and undone.

1. Sign up at the [Enable Banking control panel](https://enablebanking.com/cp/) and create an application. A **Sandbox** app reaches mock banks and accepts `http://localhost:3000/api/bank/callback` as its redirect URL. A **Production** app runs in restricted mode (only accounts you link) and accepts only `https://` redirect URLs, so it needs an HTTPS address for Moneo's callback.
2. Let the control panel generate the key pair and keep the downloaded private key (`<application-id>.pem`).
3. In the control panel, link your own accounts to the application. Only linked accounts can be synced.
4. Add to `.env`, then restart Moneo:
   - `ENABLE_BANKING_APP_ID`: the application ID
   - `ENABLE_BANKING_PRIVATE_KEY`: the PEM contents (one line with literal `\n` is fine)
5. Use **Import → Connected banks → Choose a bank → Connect bank**.

Consent usually lasts up to 180 days, depending on the bank, and a reconnect banner appears 7 days before it ends. PSD2 allows about 4 background fetches a day per bank; Moneo syncs about once a day, and **Sync now** runs with you present, so it doesn't count. Pending transactions are not synced.

## Checks

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run test:e2e` | Playwright browser tests (see [e2e/README.md](e2e/README.md)) |

Browser tests use a separate QA user, never the owner's workspace: `node --env-file=.env scripts/e2e-auth.mjs` creates it and saves its session, and `--reset` empties its workspace.
