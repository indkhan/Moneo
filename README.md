# Moneo

Moneo is an open-source personal finance app that runs on your own computer. Import bank statements or sync your bank, track accounts and wealth, plan spending, and ask questions about your money in chat or on a voice call. Figures always come from your own records; the AI explains them and suggests changes that you accept.

Website: **[indkhan.github.io/Moneo](https://indkhan.github.io/Moneo/)** — screenshots, what Moneo does, and the right installer for your computer.

Everything stays on your computer. There are no accounts and no sign-in screen: one owner, one workspace. The only data that leaves your computer goes to the services you connect (your AI provider, and optionally your bank or Scalable Capital).

## Install

### Download the app (no terminal needed)

Download the installer for your computer from the [website](https://indkhan.github.io/Moneo/#download) or [GitHub releases](https://github.com/indkhan/Moneo/releases), install it and open Moneo; nothing else is needed. Windows and Linux installers are published; macOS arrives with the next release (until then, use the source installation below). Home then shows three first steps: turn on AI, add your money, run the agent team. Settings → App updates installs newer releases and keeps your data. See [desktop setup and operation](desktop/README.md) for packaging, data locations, backups and signing requirements. The desktop app bundles its local backend and does not require Docker or Node.js. The source installation below remains supported.
Scalable questions in chat and voice can combine live holdings, paginated transaction history and transaction details with local JavaScript calculations. The calculation sandbox has no network, filesystem or credentials. Read results remain subject to your AI data scopes and are sent to your configured AI provider as needed to answer. Trades still require accepting an approval card. No additional setup is needed.

Chat can also answer questions no built-in tool covers by running a read-only SQL query over your finance records. It runs as you, only within your own data and AI data scopes, can't change anything, and can't see stored bank or Scalable tokens, AI keys or settings; each query is shown under the answer's tools.

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

- **Sign in with ChatGPT** to use your ChatGPT Go, Plus or Pro plan,
- **Sign in with Claude** to use your Claude Pro, Max, Team or Enterprise plan (see [Use your Claude plan](#use-your-claude-plan-optional)), or
- **Paste an OpenAI API key** ([create one here](https://platform.openai.com/api-keys)) and click **Save key**. Usage is billed to that key.

Voice calls and dictation need the OpenAI API key. An OpenRouter key is optional (for other models).

#### 6. Add your money

- **Import** a CSV or Excel export from your bank, or
- connect your bank or Scalable Capital (optional, see below).

That's it. Want it on your phone or tablet too? See [Use it from your phone or tablet](#use-it-from-your-phone-or-tablet-optional).

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

Opening Moneo or coming back to it also syncs in the background (Scalable at most every 15 minutes, banks at most every hour): you see the last numbers right away and the page updates when the sync lands. If a value can't be refreshed, it still counts in your net worth and Wealth marks it as not from today. A short message in the corner of Home tells you once about old values and about a connection that failed or needs reconnecting.

New transactions are organized for you. Moneo first uses what your bank sent (merchant codes, counterparty, your own accounts for transfers and currency exchanges) and what you have already confirmed; the AI labels the rest. Labels the AI is sure about are applied right away and marked as AI; the ones it isn't sure about wait for you. **Money → AI organizer** lists both: answer a question once and every row from that payee follows, confirm or undo any AI decision, and edit what Moneo remembers. You can also ask about them in chat.

## Keys and connections

Every key and outside service is set up in the app under **Settings → Keys and connections**. Keys are checked with the provider before they are saved, stored encrypted in your database, shown only by their last four characters, and can be replaced or removed at any time. The same section shows that the secrets made by `npm run setup` are in place.

### Use your Claude plan (optional)

Moneo can run on your Claude subscription instead of an API key. It uses Claude Code, which comes with Moneo, signed in with your own Claude account on this computer. Moneo never sees or stores your Claude login; Claude Code keeps it, the same one the Claude Code app uses.

1. In **Settings → AI access**, click **Sign in with Claude** on this computer. A Claude sign-in page opens in your browser.
2. Sign in. If the page shows a code, paste it into Moneo and click **Continue**. If you're already signed in to Claude Code, Moneo shows your account straight away; click **Use Claude plan**.

Chat, artifacts, briefings, imports and the agents then run on Claude (Opus 5.5 for the chat, Haiku 5.5 for lighter tasks; change them under **Settings → AI and your data → Advanced**). Requests count toward your plan's usage limits, shown at [claude.ai/settings/usage](https://claude.ai/settings/usage).

- **Never billed to an API key.** Moneo removes `ANTHROPIC_API_KEY` and similar settings before it starts Claude Code, and only runs Claude when Claude Code is signed in with a Claude plan. If you sign out of Claude Code, AI stays off until you sign in again or pick another option.
- **Only Moneo's tools.** Claude gets Moneo's finance tools and nothing else: no files, no shell, no other MCP servers, and no chat history saved by Claude Code. Changes still go through cards you accept.
- **Not yet:** voice calls and dictation, which still need an OpenAI API key for the audio.
- **Stop using Claude** switches Moneo back to ChatGPT or your API key. It doesn't sign you out of Claude Code.
- Anthropic's rules say apps may not offer Claude plan sign-in without its approval ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)). Moneo only uses the Claude Code login you set up yourself, on your own computer. Decide for yourself whether that fits your use.

### Connect your bank (optional)

Moneo syncs booked transactions and balances from EU banks (for example Revolut and Commerzbank) through [Enable Banking](https://enablebanking.com). It is free for personal use. Each sync is an ordinary import that you can review and undo. Moneo also keeps what the bank sent for each transaction (codes, counterparty details, references) on your computer to help organize it; undoing a sync removes it.

1. Sign up at the [Enable Banking control panel](https://enablebanking.com/cp/) and create an application in the **Production** environment.
2. Fill in the application form:
   - Redirect URL: `https://localhost:3443/api/bank/callback`
   - Privacy policy URL: `https://indkhan.github.io/Moneo/privacy.html`
   - Terms of service URL: `https://indkhan.github.io/Moneo/terms.html`
3. Let the control panel make the key pair, and keep the downloaded private key file (`<application-id>.pem`).
4. In the control panel, link your own bank accounts to the application. Only linked accounts can be synced.
5. In Moneo, go to **Settings → Keys and connections → Connected banks** (also on the Import page). Paste the application ID, paste the private key or upload the `.pem` file, and click **Save and check**.
6. Click **Choose a bank**, pick yours, click **Connect bank** and approve access at your bank. Some banks (for example in Italy, Sweden and the Baltics) ask you to approve twice: once for access and once for history older than 90 days. Questions about the Enable Banking control panel go to support.api@enablebanking.com, where an assistant answers personal-use applications.

Bank consent usually lasts up to 180 days; Moneo shows a reconnect banner 7 days before it ends. Pending transactions are not synced. Your banks sync together once a day, and a few minutes after the last one lands Moneo organizes and checks the new rows in one go; if the AI's plan limit is reached, the rest waits until the limit resets. Banks usually share your full history only right after you approve access, so if that first sync fails Moneo tries again up to three times within about an hour. When the bank limits one account, that account waits as long as the bank asks while your other accounts keep syncing. If Enable Banking says it rejected the return address, add the Redirect URL from step 2 to your application and try again.

### Connect Scalable Capital (optional)

1. In Scalable on the web, go to **Profile → Security → Agentic Investing** and turn on access (read-only is enough).
2. In Moneo, click **Connect Scalable Capital** under **Settings → Keys and connections** (also on the Import page) and log in to Scalable (with 2FA in the Scalable app).

Moneo then reads your holdings, totals and cash every day and shows the portfolio on Wealth. No keys are needed. It also keeps Scalable's own record of your deposits and withdrawals, read in full once after connecting, so money moving between your bank and Scalable counts once on every day of the net worth chart, and a withdrawal that bounced back looks as if the money stayed.

Soon after the first sync, a background job works out your portfolio's past value from your Scalable transactions and past prices, so its chart reaches back to your first trade and connecting a portfolio doesn't look like a gain in net worth. Those days are an estimate, saved apart from your real records: prices further than a year back are monthly. Moneo only saves them if replaying your transactions lands on the shares and cash you hold today; otherwise the chart simply starts at your first sync, and it tries again the next day. Disconnecting keeps them, like your synced values, and resetting all data clears them.

Artifact Pages and Home cards can show your Scalable portfolio, recent activity and watchlist. By default they use the last sync, the same figures as Wealth. Turn on **Live Scalable data in artifacts** in Settings → AI and your data to read Scalable each time one opens; that also allows quotes, charts and news for any security, but loads slower and needs Scalable to be reachable.

### Use it from your phone or tablet (optional)

Your phone becomes another screen on the Moneo running on this computer: same data, same ChatGPT, Claude, bank and Scalable connections. It is off until you turn it on, and nothing changes on this computer.

1. Go to **Settings → Keys and connections → Phone and tablet** and click **Turn on**. Moneo tells you if it needs [Tailscale](https://tailscale.com/download) installed, a sign-in, or one approval for secure addresses.
2. On your phone or tablet, install Tailscale and sign in with the same account.
3. Scan the code in Settings, then choose **Add to Home Screen**.

The address and code are your own, from your own Tailscale account. Only devices on your Tailscale network can reach Moneo, and they get in without a password, so don't use a network you share with other people. Leave Tailscale Funnel off: Moneo refuses traffic from the public internet.

Moneo then opens like an app. It never keeps your numbers on the phone: when the computer is off, it says so and shows nothing until the computer is back.

Keep this computer on and awake with Moneo running: on a laptop, stay plugged in and set closing the lid to do nothing. After a restart, start Docker and run `npm start` again. On Windows, `tailscale set --unattended=true` keeps Tailscale connected after a restart. New ChatGPT, Claude, bank and Scalable logins start on this computer, because those services only return to its address. On Linux, first run `sudo tailscale set --operator=$USER`.

How it works, step by step: [docs/phone-access-deep-dive.html](docs/phone-access-deep-dive.html).

## Good to know

- Moneo only listens on `127.0.0.1`, so other devices on your network can't open it unless you turn on [phone and tablet access](#use-it-from-your-phone-or-tablet-optional).
- **Files in chat:** attach photos, PDFs, Word (DOCX), PowerPoint (PPTX), Excel (XLSX) or CSV files, up to four of 25 MB each. Documents are turned into text on your computer, the same way for every AI source; scanned PDF pages are sent as images. Answers show small chips such as `statement.pdf · p.3` that open the page, slide, paragraph or cell they came from.
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
