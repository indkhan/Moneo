# Moneo

Moneo is a personal finance workspace for importing transactions, tracking accounts, planning spending, and exploring your finances with AI. It is a Next.js and TypeScript app backed by Supabase.

## Run locally

1. Install dependencies: `npm ci`
2. Copy `.env.example` to `.env` and add your Supabase URL and publishable key. Add `SUPABASE_SERVICE_ROLE_KEY` for import and analysis workflows, and `OPENROUTER_API_KEY` for AI features.
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

## Checks

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run test:e2e` | Playwright browser tests |

The browser tests include a live-backend journey that skips until its prerequisites are configured; see [e2e/README.md](e2e/README.md).

## Project notes

- [Product plan](plan.md)
- [Architecture and stack](stack.md)
- [End-to-end test setup and coverage](e2e/README.md)
