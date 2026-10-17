"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Mode = "sign-in" | "sign-up" | "magic-link" | "forgot";

const subscribeToCallback = () => () => {};
const callbackError = () => new URLSearchParams(window.location.search).get("error") === "sign-in";

const copy: Record<Mode, { title: string; hint: string; button: string }> = {
  "sign-in": { title: "Sign in to Moneo", hint: "Use your email and password.", button: "Sign in" },
  "sign-up": { title: "Create your account", hint: "Choose an email and password.", button: "Create account" },
  "magic-link": { title: "Sign in to Moneo", hint: "Enter your email to receive a sign-in link.", button: "Send sign-in link" },
  forgot: { title: "Reset your password", hint: "We'll email you a link to set a new password.", button: "Send reset link" },
};

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const failedCallback = useSyncExternalStore(subscribeToCallback, callbackError, () => false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setMessage("");
    try {
      const auth = createClient().auth;
      const callback = `${window.location.origin}/auth/callback`;
      if (mode === "magic-link") {
        const { error } = await auth.signInWithOtp({ email, options: { emailRedirectTo: callback } });
        setMessage(error?.message ?? "Check your email for the sign-in link.");
      } else if (mode === "forgot") {
        const { error } = await auth.resetPasswordForEmail(email, { redirectTo: `${callback}?next=/reset-password` });
        setMessage(error?.message ?? "Check your email for the password reset link.");
      } else {
        const { data, error } = mode === "sign-in"
          ? await auth.signInWithPassword({ email, password })
          : await auth.signUp({ email, password, options: { emailRedirectTo: callback } });
        if (error) setMessage(error.message);
        else if (data.session) { router.replace("/"); router.refresh(); }
        // Only reached when the Supabase project still requires email confirmation.
        else setMessage("Check your email to confirm your account.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong. Try again.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  function switchTo(next: Mode) {
    setMode(next);
    setMessage("");
  }

  const link = "underline hover:text-foreground";
  const input = "min-h-10 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";
  const usesPassword = mode === "sign-in" || mode === "sign-up";

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-sm">
        <div className="mb-8 flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-lg bg-primary text-lg font-bold text-primary-foreground">M</span><span className="text-lg font-semibold tracking-tight">Moneo</span></div>
        <p className="text-xs font-semibold uppercase tracking-widest text-brand">Your workspace</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{copy[mode].title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{copy[mode].hint}</p>
        <form onSubmit={submit} className="mt-6 space-y-3">
          <label className="block text-sm font-medium" htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} className={input} />
          {usesPassword && <>
            <label className="block text-sm font-medium" htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete={mode === "sign-up" ? "new-password" : "current-password"} minLength={mode === "sign-up" ? 8 : undefined} required value={password} onChange={(event) => setPassword(event.target.value)} className={input} />
          </>}
          <button disabled={pending} className="min-h-10 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{pending ? "Working…" : copy[mode].button}</button>
        </form>
        <p role="status" className="mt-4 min-h-5 text-sm text-muted-foreground">{message ?? (failedCallback ? "The sign-in link could not be verified. Request a new link and try again." : "")}</p>
        <div className="mt-4 flex flex-col items-center gap-2 text-sm text-muted-foreground">
          {mode !== "sign-in" && <button type="button" onClick={() => switchTo("sign-in")} className={link}>Sign in with password</button>}
          {mode !== "sign-up" && <button type="button" onClick={() => switchTo("sign-up")} className={link}>Create an account</button>}
          {mode !== "magic-link" && <button type="button" onClick={() => switchTo("magic-link")} className={link}>Email me a sign-in link</button>}
          {mode !== "forgot" && <button type="button" onClick={() => switchTo("forgot")} className={link}>Forgot password?</button>}
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground"><a href="/privacy" className={link}>Privacy</a><span aria-hidden="true"> · </span><a href="/terms" className={link}>Terms</a></p>
        {process.env.NODE_ENV === "development" && <form method="post" action="/auth/dev" className="mt-6 border-t border-border pt-6">
          <input type="hidden" name="email" value={email} />
          <button disabled={!email} className="min-h-10 w-full rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">Sign in instantly (local dev)</button>
        </form>}
      </div>
    </main>
  );
}
