"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authErrorMessage } from "@/app/login/auth-messages";
import { PasswordInput } from "@/app/login/password-input";
import { createClient } from "@/lib/supabase-client";

const newLink = "block min-h-11 font-medium underline underline-offset-2";

// Reached from the password-reset email (signed in via /auth/callback) and from Settings. Any
// signed-in user, including magic-link-only accounts, can set a password here.
export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  // Without a session the save can only fail, so say so before anyone types a password. `undefined` while checking.
  const [email, setEmail] = useState<string | null>();
  useEffect(() => { createClient().auth.getUser().then(({ data }) => setEmail(data.user ? data.user.email ?? "" : null), () => setEmail(null)); }, []);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    try {
      const { error } = await createClient().auth.updateUser({ password });
      if (error) setMessage(authErrorMessage(error));
      else { setSaved(true); router.refresh(); }
    } catch (error) {
      setMessage(authErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 sm:p-8">
        <h1 className="page-title">Set a new password</h1>
        {saved ? <div className="mt-4 space-y-4 text-sm"><p role="status">Your password was changed. You are still signed in on this device.</p><Link href="/" className="flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground hover:opacity-90">Continue to Moneo</Link></div>
          : email === null ? <div className="mt-4 space-y-4 text-sm"><p role="alert">This reset link is missing or has expired.</p><Link href="/login?mode=forgot" className={newLink}>Send a new reset link</Link><Link href="/login" className={newLink}>Back to sign in</Link></div>
          : <>
            {email && <p className="mt-2 break-words text-sm text-muted-foreground">For {email}. You do not need your current password.</p>}
            <form onSubmit={save} className="mt-6 space-y-3">
              <label className="block text-sm font-medium" htmlFor="password">New password <span className="font-normal text-muted-foreground">(at least 8 characters)</span></label>
              <PasswordInput id="password" autoComplete="new-password" minLength={8} required value={password} aria-invalid={!!message} aria-describedby={message ? "password-error" : undefined} onChange={(event) => setPassword(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20" />
              <button disabled={pending || email === undefined} className="min-h-11 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{pending ? "Saving…" : "Save password"}</button>
            </form>
            {message && <p id="password-error" role="alert" className="mt-4 text-sm text-danger">{message}</p>}
            {/* Valid for this page's session only: the same wording appears when a save finds the session gone. */}
            {message.startsWith("Your reset link") && <Link href="/login?mode=forgot" className={`${newLink} mt-3 text-sm`}>Send a new reset link</Link>}
            {email && <Link href="/settings" className="mt-3 flex min-h-11 items-center justify-center text-sm text-muted-foreground underline hover:text-foreground">Cancel, back to Settings</Link>}
          </>}
      </div>
    </main>
  );
}
