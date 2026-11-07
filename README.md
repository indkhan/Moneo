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
- **OpenAI API key**: paste it under **OpenAI API key** and click **Save key**. Usage is billed to that key.

You can also save an **OpenRouter API key** there. Keys are checked with the provider before they are saved, stored encrypted in Moneo's database (they survive restarts and Reset all data), shown only by their last four characters, and can be replaced or removed at any time. You don't need to edit `.env`.

Voice calls and dictation need the OpenAI API key, because ChatGPT plan usage and OpenRouter don't support realtime audio. Models are chosen per agent under Settings → AI and your data; IDs with a `/` (for example `vendor/model`) go to OpenRouter. With only an OpenRouter key, the plain default IDs run on OpenRouter as `openai/<id>`.

Older installs that set `OPENAI_API_KEY` or `OPENROUTER_API_KEY` in `.env` keep working; a key saved in the app takes precedence.

## Background jobs

While Moneo runs, it checks hourly for scheduled summaries, review recovery, bank sync and Scalable Capital sync. Each sync runs about once a day, and anything missed while the computer was off runs shortly after Moneo starts.

## Scalable Capital (optional)

First turn on access in Scalable on the web under Profile → Security → Agentic Investing (read-only is enough). Then Import → **Connect Scalable Capital** opens Scalable's login (with 2FA in the Scalable app). Moneo then reads your holdings, totals and cash daily as wealth records, and shows the portfolio on Accounts. It uses Scalable's official read-only MCP server and needs no keys.

## Connect your bank (optional)

Moneo can sync booked transactions and balances from EU banks (for example Revolut and Commerzbank) through [Enable Banking](https://enablebanking.com). Its restricted mode is free for personal use and covers the accounts you link yourself. Each sync is written as an ordinary import, so it shows in import history and can be reviewed and undone.

1. Sign up at the [Enable Banking control panel](https://enablebanking.com/cp/) and create an application in the **Production** environment. A new production app runs in restricted mode: free, and limited to the accounts you link yourself.
2. Fill in the application form:
   - Redirect URL: `https://localhost:3443/api/bank/callback`
   - Privacy policy URL: `https://indkhan.github.io/Moneo/privacy.html`
   - Terms of service URL: `https://indkhan.github.io/Moneo/terms.html`
3. Let the control panel generate the key pair and keep the downloaded private key (`<application-id>.pem`).
4. In the control panel, link your own accounts to the application. Only linked accounts can be synced.
5. In Moneo, open **Import → Connected banks**, paste the application ID, paste the private key or upload the `.pem` file, and click **Save and check**. Moneo checks them with Enable Banking and stores them encrypted; **Replace** and **Remove** are next to the bank picker. (An existing `ENABLE_BANKING_APP_ID` and `ENABLE_BANKING_PRIVATE_KEY` in `.env` keep working until you save new ones here.)
6. Use **Import → Connected banks → Choose a bank → Connect bank**. If Enable Banking says it rejected the return address, add the Redirect URL from step 2 to your application and try again.

Consent usually lasts up to 180 days, depending on the bank, and a reconnect banner appears 7 days before it ends. PSD2 allows about 4 background fetches a day per bank; Moneo syncs about once a day, and **Sync now** runs with you present, so it doesn't count. Pending transactions are not synced.

Enable Banking only accepts `https://` return addresses, so after you approve access the bank sends you to `https://localhost:3443`. Moneo answers there with a certificate `npm run setup` made and trusted on this computer only (using [mkcert](https://github.com/FiloSottile/mkcert); the first run may ask you to allow it), and passes you straight back to Moneo.

## Checks

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run test:e2e` | Playwright browser tests (see [e2e/README.md](e2e/README.md)) |

Browser tests use a separate QA user, never the owner's workspace: `node --env-file=.env scripts/e2e-auth.mjs` creates it and saves its session, and `--reset` empties its workspace.

## License

[MIT](LICENSE)
