# Moneo

Moneo is an open-source personal finance app that runs on your own computer. Import bank statements or sync your bank, track accounts and wealth, plan spending, and ask questions about your money in chat or on a voice call. Figures always come from your own records; the AI explains them and suggests changes that you accept.

Everything stays on your computer. There are no accounts and no sign-in screen: one owner, one workspace. The only data that leaves your computer goes to the services you connect (your AI provider, and optionally your bank or Scalable Capital).

## Install

### Easiest: let an AI agent install it

If you use an AI coding agent such as Claude Code or Codex, it can do the install for you with the `moneo-setup` skill that comes with Moneo. Open the agent in an empty folder and paste:

> Clone https://github.com/indkhan/Moneo, then set it up by following .agents/skills/moneo-setup/SKILL.md in that repository.

If you already downloaded Moneo, open the agent in the Moneo folder and say **"set up Moneo"**. The agent runs the commands, tells you what each step does, and asks you only for what it can't do itself, like installing Docker or entering your keys in Moneo. If it can control your browser or computer, it asks first and then does the clicking too. You type passwords and keys yourself.

### Or install it yourself

#### 1. Install the tools

- [Git](https://git-scm.com/downloads)
- [Node.js](https://nodejs.org) version 22 or newer
- [Docker Desktop](https://docs.docker.com/get-docker/) (on Linux, Docker Engine with Compose)

Start Docker Desktop and wait until it says it is running.

#### 2. Download Moneo

```sh
git clone https://github.com/indkhan/Moneo.git
cd Moneo
npm ci
```

#### 3. Run the setup

```sh
npm run setup
```

This creates the database in Docker, makes all the passwords and secrets Moneo needs, and saves them in a file called `.env`. The first run downloads a few GB and takes several minutes; you need about 4 GB of free disk space. On Windows a security prompt may ask to install a local certificate: click **Yes** (it is only used for bank connections and only trusted on this computer).

You never need to open or edit `.env`. Keep it private and don't delete it.

#### 4. Start Moneo

```sh
npm run build
npm start
```

The build takes a few minutes the first time. Then open **http://localhost:3000**.

#### 5. Turn on the AI

Go to **Settings → Keys and connections → AI access** and choose one:

- **Sign in with ChatGPT** to use your ChatGPT Go, Plus or Pro plan, or
- **Paste an OpenAI API key** ([create one here](https://platform.openai.com/api-keys)) and click **Save key**. Usage is billed to that key.

Voice calls and dictation need the OpenAI API key. An OpenRouter key is optional (for other models).

#### 6. Add your money

- **Import** a CSV or Excel export from your bank, or
- connect your bank or Scalable Capital (optional, see below).

That's it.

## Everyday use

- **Start Moneo:** `npm start` in the Moneo folder (Docker Desktop must be running).
- **Stop Moneo:** press `Ctrl+C`. The database keeps running in Docker; `docker compose stop` stops it.
- **Update Moneo:**
  ```sh
  git pull
  npm ci
  npm run setup
  npm run build
  npm start
  ```
  Your data and secrets are kept.

While Moneo runs it does its background work by itself: scheduled summaries, and syncing your bank and Scalable about once a day. Anything missed while your computer was off runs shortly after you start Moneo.

## Keys and connections

Every key and outside service is set up in the app under **Settings → Keys and connections**. Keys are checked with the provider before they are saved, stored encrypted in your database, shown only by their last four characters, and can be replaced or removed at any time. The same section shows that the secrets made by `npm run setup` are in place.

### Connect your bank (optional)

Moneo syncs booked transactions and balances from EU banks (for example Revolut and Commerzbank) through [Enable Banking](https://enablebanking.com). It is free for personal use. Each sync is an ordinary import that you can review and undo.

1. Sign up at the [Enable Banking control panel](https://enablebanking.com/cp/) and create an application in the **Production** environment.
2. Fill in the application form:
   - Redirect URL: `https://localhost:3443/api/bank/callback`
   - Privacy policy URL: `https://indkhan.github.io/Moneo/privacy.html`
   - Terms of service URL: `https://indkhan.github.io/Moneo/terms.html`
3. Let the control panel make the key pair, and keep the downloaded private key file (`<application-id>.pem`).
4. In the control panel, link your own bank accounts to the application. Only linked accounts can be synced.
5. In Moneo, go to **Settings → Keys and connections → Connected banks** (also on the Import page). Paste the application ID, paste the private key or upload the `.pem` file, and click **Save and check**.
6. Click **Choose a bank**, pick yours, click **Connect bank** and approve access at your bank.

Bank consent usually lasts up to 180 days; Moneo shows a reconnect banner 7 days before it ends. Pending transactions are not synced. If Enable Banking says it rejected the return address, add the Redirect URL from step 2 to your application and try again.

### Connect Scalable Capital (optional)

1. In Scalable on the web, go to **Profile → Security → Agentic Investing** and turn on access (read-only is enough).
2. In Moneo, click **Connect Scalable Capital** under **Settings → Keys and connections** (also on the Import page) and log in to Scalable (with 2FA in the Scalable app).

Moneo then reads your holdings, totals and cash every day and shows the portfolio on Wealth. No keys are needed.

Artifact Pages and Home cards can show your Scalable portfolio, recent activity and watchlist. By default they use the last sync, the same figures as Wealth. Turn on **Live Scalable data in artifacts** in Settings → AI and your data to read Scalable each time one opens; that also allows quotes, charts and news for any security, but loads slower and needs Scalable to be reachable.

### Use it from your phone or tablet (optional)

Your phone becomes another screen on the Moneo running on this computer: same data, same ChatGPT, bank and Scalable connections. It is off until you turn it on, and nothing changes on this computer.

1. Go to **Settings → Keys and connections → Phone and tablet** and click **Turn on**. Moneo tells you if it needs [Tailscale](https://tailscale.com/download) installed, a sign-in, or one approval for secure addresses.
2. On your phone or tablet, install Tailscale and sign in with the same account.
3. Scan the code in Settings, then choose **Add to Home Screen**.

Only devices in your Tailscale account can reach Moneo, and they get in without a password, so don't add other people to it. Leave Tailscale Funnel off: Moneo refuses traffic from the public internet.

Keep this computer on and awake with Moneo running: on a laptop, stay plugged in and set closing the lid to do nothing. On Windows, `tailscale set --unattended=true` keeps Tailscale connected after a restart. New ChatGPT, bank and Scalable logins start on this computer, because those services only return to its address.

## Good to know

- Moneo only listens on `127.0.0.1`, so other devices on your network can't open it unless you turn on [phone and tablet access](#use-it-from-your-phone-or-tablet-optional).
- Your data lives in the Docker volumes `moneo_db-data` and `moneo_storage-data`. `docker compose down` keeps them; **`docker compose down -v` deletes all your data**.
- If ports 54321 or 54322 are already in use, add `API_PORT=` and `DB_PORT=` with free ports to `.env` and run `npm run setup` again.

## Development

Use `npm run dev` instead of build and start. See [AGENTS.md](AGENTS.md) for how the project works.

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run test:e2e` | Playwright browser tests (see [e2e/README.md](e2e/README.md)) |

Browser tests use a separate QA user, never the owner's workspace: `node --env-file=.env scripts/e2e-auth.mjs` creates it and saves its session, and `--reset` empties its workspace.

## License

[MIT](LICENSE)
