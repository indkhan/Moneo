# Moneo

Moneo is a personal finance workspace for importing transactions, tracking accounts, planning spending, and exploring your finances with AI. It is a Next.js and TypeScript app backed by Supabase.

## Run locally

1. Install dependencies: `npm ci`
2. Copy `.env.example` to `.env` and add your Supabase URL and publishable key. Add `SUPABASE_SERVICE_ROLE_KEY` for import and analysis workflows, and `OPENAI_API_KEY` for AI features (models per agent are set in Settings).
3. Apply the SQL files in `supabase/migrations/` to your Supabase project in filename order. Configure Supabase email sign-in with `http://localhost:3000/auth/callback` as an allowed redirect URL.
4. Start the app: `npm run dev`, then open [http://localhost:3000](http://localhost:3000).
5. Sign in: during `npm run dev` on localhost, type your email and click **Sign in instantly (local dev)**. It needs `SUPABASE_SERVICE_ROLE_KEY`, sends no email, and is disabled in production builds. The normal email link also works, but must be opened in the same browser that requested it.

Without Supabase keys, the home page shows a setup message. Keep `.env` private; it is git-ignored.

If `npm run dev` says another server is already running, stop the old one (the message prints its PID, e.g. `taskkill /PID <pid> /F` on Windows) and start again.

## Deploy to Vercel

Set the environment variables from `.env.example` in Vercel, using your deployed website origin for `NEXT_PUBLIC_APP_URL` (for example, `https://your-moneo.vercel.app`).

In the same Supabase project used by Vercel, open **Authentication → URL Configuration**:

1. Set **Site URL** to your deployed website origin.
2. Add the exact deployed callback URL to **Redirect URLs**, for example `https://your-moneo.vercel.app/auth/callback`. Keep `http://localhost:3000/auth/callback` for local development. Add each additional domain you use for sign-in explicitly.
3. Under **Authentication → Email Templates**, ensure **Confirm signup** and **Magic Link** use `{{ .ConfirmationURL }}` as their sign-in link, without a hardcoded localhost URL.

The login page supplies the current website's `/auth/callback` as `emailRedirectTo`. Supabase must allow that exact URL or it falls back to **Site URL**, which defaults to localhost. Changing `NEXT_PUBLIC_APP_URL` alone does not change Supabase's authentication settings. See [Supabase redirect troubleshooting](https://supabase.com/docs/guides/troubleshooting/why-am-i-being-redirected-to-the-wrong-url-when-using-auth-redirectto-option-_vqIeO).

After saving the settings, request a new sign-in email from the deployed website and open it in the same browser used to request it. Previously sent emails retain their original URLs.

## Connect your bank (optional)

Moneo can sync booked transactions and balances from EU banks (for example Revolut and Commerzbank) through [Enable Banking](https://enablebanking.com). Its restricted mode is free for personal use and covers the accounts you link yourself. Each sync is written as an ordinary import, so it shows in import history and can be reviewed and undone.

1. Sign up at the [Enable Banking control panel](https://enablebanking.com/cp/) and create a new application in the **Production** environment. A new production app runs in restricted mode, which limits it to linked accounts.
2. Set the redirect URL to `https://<your-app>/api/bank/callback`. Production apps accept only `https://` redirects, so `http://localhost` is rejected. To try the flow locally, register a second app in the **Sandbox** environment (it only reaches mock banks) with `http://localhost:3000/api/bank/callback`.
3. Let the control panel generate the key pair and keep the downloaded private key (`<application-id>.pem`), or upload your own public certificate and keep its private key.
4. In the control panel, link your own accounts to the application (activate it by linking accounts). Only linked accounts can be synced.
5. Set the environment variables in `.env`:
   - `ENABLE_BANKING_APP_ID`: the application ID
   - `ENABLE_BANKING_PRIVATE_KEY`: the PEM contents (one line with literal `\n` is fine)
   - `BANK_TOKEN_ENCRYPTION_KEY`: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   - `SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_APP_URL` (the callback base) must also be set
6. Apply the new migrations, restart `npm run dev`, then use **Import → Connected banks → Choose a bank → Connect bank**.

Consent usually lasts up to 180 days, depending on the bank. A reconnect banner appears 7 days before it ends. A daily cron (`/api/cron/bank-sync`, authorized by `CRON_SECRET`) syncs in the background. PSD2 allows about 4 background fetches a day per bank. **Sync now** runs with you present, so it doesn't count toward that limit. Pending transactions are not synced. The first sync, and the next one after you undo a sync import, asks for full history. How far back that goes is up to the bank: under PSD2 most share full history only shortly after you approve access, and about 90 days later on.

## Checks

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run test:e2e` | Playwright browser tests |

The browser tests include a live-backend journey that skips until its prerequisites are configured; see [e2e/README.md](e2e/README.md).

## Project notes

- [End-to-end test setup and coverage](e2e/README.md)
