---
name: moneo-setup
description: Install, set up, start, update or troubleshoot Moneo on the user's own computer. Use when someone says "set up Moneo", "install Moneo", "Moneo won't start", or asks how to add their AI key, bank or Scalable Capital, or use Moneo on their phone or tablet.
---

# Set up Moneo

You are helping a person, often not a developer, run Moneo on their own computer. Do the commands yourself, explain each step in one plain sentence, and only ask them for things you can't do yourself. The README's **Install** section is the same flow written for people.

**If you can control a browser or the computer** (browser use, computer use or similar), ask the person once whether you may, then do the clicking yourself: install Git, Node or Docker Desktop, start Docker, open Moneo, go to Settings → Keys and connections, open the Enable Banking control panel. Stop and hand over whenever a password, API key, private key, 2FA code or bank approval is needed: the person types those. Without that control, tell them exactly what to click.

## Rules

- Never ask the person to paste API keys, bank keys or passwords into this chat. Keys go into Moneo's own page: **Settings → Keys and connections**.
- Never edit `.env` by hand, except `API_PORT` / `DB_PORT` for a port clash. `npm run setup` writes everything else.
- Never change `POSTGRES_PASSWORD`, `JWT_SECRET` or `BANK_TOKEN_ENCRYPTION_KEY` in an existing `.env`, never delete `.env`, and never run `docker compose down -v` or delete the `moneo_*` Docker volumes. That is the person's financial data.
- Only stop processes you started.

## Steps

1. **Check the tools.** Run `git --version`, `node --version` (needs 22 or newer) and `docker info`.
   - Missing Git, Node or Docker: give the download link (git-scm.com/downloads, nodejs.org, docs.docker.com/get-docker) and wait for them to install it.
   - `docker info` fails: Docker Desktop is not running. Ask them to start it and wait until it says it is running.
2. **Get the code.** If you are not already in a Moneo checkout (`package.json` with `"name": "moneo"`), run `git clone https://github.com/indkhan/Moneo.git` and `cd Moneo`. Then `npm ci`.
3. **Run the setup:** `npm run setup`. It creates `.env` with fresh secrets, starts the database in Docker, applies migrations, creates the owner and makes a local HTTPS certificate. The first run downloads a few GB (about 4 GB of disk). On Windows, tell them a "Security Warning" about installing a certificate may appear and to click **Yes**. It is safe to rerun.
4. **Start Moneo:** `npm run build`, then `npm start` (keep it running; use a background terminal if you can). Open http://localhost:3000.
5. **Turn on the AI.** Ask them to open **Settings → Keys and connections → AI access** and either click **Sign in with ChatGPT** (Go, Plus or Pro plan) or paste an OpenAI API key from https://platform.openai.com/api-keys and click **Save key**. Voice calls need the API key.
6. **Optional: bank.** Follow the README section "Connect your bank". The person creates an Enable Banking application (Production) with redirect URL `https://localhost:3443/api/bank/callback`, links their own accounts there, and pastes the App ID and `.pem` key into **Settings → Keys and connections → Connected banks**.
7. **Optional: Scalable Capital.** They turn on Agentic Investing in Scalable (Profile → Security), then click **Connect Scalable Capital** in the same Settings section.
8. **Optional: phone and tablet.** Offer this once and skip it unless they want it. It lets their own phone and tablet use the Moneo on this computer, through their own free Tailscale account.
   - Ask them to open **Settings → Keys and connections → Phone and tablet** and click **Turn on**. The card shows only the step that is missing: install [Tailscale](https://tailscale.com/download), sign in, or allow secure addresses. They click **Check again** after each one. The sign-in and approval are theirs to do.
   - The address and QR code come from their own Tailscale. Read them from the card; never type or guess an address.
   - On each phone or tablet: install Tailscale, sign in with the same account, scan the code, then Add to Home Screen.
   - Tell them plainly: everyone on their Tailscale network gets in without a password, so don't use a shared network; never turn on Tailscale Funnel; the computer must stay awake with Moneo running; new ChatGPT, bank and Scalable logins start on the computer.
9. **Finish** by telling them how to start Moneo next time (`npm start` with Docker running) and how to update (`git pull`, `npm ci`, `npm run setup`, `npm run build`, `npm start`).

## When something goes wrong

| Symptom | Fix |
| --- | --- |
| `docker` not found, or "cannot connect to the Docker daemon" | Install or start Docker Desktop, then rerun `npm run setup`. |
| "port is already allocated" for 54321 or 54322 | Add `API_PORT=55421` and `DB_PORT=55422` (any free ports) to `.env` and rerun `npm run setup`. |
| Port 3000 or 3443 in use | Another program (often an older Moneo) runs there. Find it by port, ask before stopping it, then start Moneo again. |
| ".env points at a hosted Supabase" | That `.env` belongs to another setup. Rename it (don't delete it) and rerun `npm run setup`. |
| "Could not create the local HTTPS certificate" | Only bank connections need it. Rerun `npm run setup` and accept the certificate prompt. |
| Chat says "No AI is set up yet" | Step 5. |
| Bank says the return address was rejected | Add `https://localhost:3443/api/bank/callback` as a redirect URL in the Enable Banking application. |
| The phone can't open Moneo | Check Tailscale is connected on both devices, the computer is awake, and Moneo and Docker are running (after a restart, `npm start` again). |
| Phone and tablet card says something else is using the address | Often an older Moneo on another port, or another app. Ask whose it is; if it's safe to clear, run `tailscale serve --https=443 off`, then **Check again**. |
| Phone and tablet card says "Access denied" (Linux) | Run `sudo tailscale set --operator=$USER`, then **Check again**. |
| A phone says a login must start on the computer | Expected. Open Moneo on the computer running it to connect; everything else works on the phone. |
| The page shows a database error after `git pull` | Run `npm run setup` (applies new migrations), then `npm run build` and `npm start`. |
