"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { safeNextPath } from "@/lib/safe-next";
import { createClient } from "@/lib/supabase-client";
import { authErrorMessage } from "./auth-messages";
import { PasswordInput } from "./password-input";

type Mode = "sign-in" | "sign-up" | "magic-link" | "forgot";

const subscribeToCallback = () => () => {};
const callbackError = () => new URLSearchParams(window.location.search).get("error") === "sign-in";
const accountDeleted = () => new URLSearchParams(window.location.search).has("deleted");
const linkedMode = (): Mode => new URLSearchParams(window.location.search).get("mode") === "forgot" ? "forgot" : "sign-in";
const nextPath = () => safeNextPath(new URLSearchParams(window.location.search).get("next"));

const copy: Record<Mode, { title: string; hint: string; button: string; sent: string }> = {
  "sign-in": { title: "Sign in to Moneo", hint: "Use your email and password.", button: "Sign in", sent: "" },
  "sign-up": { title: "Create your account", hint: "Choose an email and a password of at least 8 characters.", button: "Create account", sent: "Check your email to confirm your account." },
  "magic-link": { title: "Sign in to Moneo", hint: "Enter your email to receive a sign-in link.", button: "Send sign-in link", sent: "Check your email for the sign-in link." },
  forgot: { title: "Reset your password", hint: "We'll email you a link to set a new password.", button: "Send reset link", sent: "Check your email for the password reset link." },
};
// Long enough that a double tap or an impatient retry cannot send a second email straight away.
const RESEND_WAIT_MS = 30_000;
type Message = { text: string; error?: boolean; sent?: boolean };

export default function LoginPage() {
  const router = useRouter();
  const [chosenMode, setMode] = useState<Mode>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const mode = useSyncExternalStore(subscribeToCallback, () => chosenMode ?? linkedMode(), () => chosenMode ?? "sign-in");
  const failedCallback = useSyncExternalStore(subscribeToCallback, callbackError, () => false);
  const deleted = useSyncExternalStore(subscribeToCallback, accountDeleted, () => false);

  function emailSent() {
    setMessage({ text: copy[mode].sent, sent: true });
    setWaiting(true);
    setTimeout(() => setWaiting(false), RESEND_WAIT_MS);
  }

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setMessage({ text: "" });
    const fail = (error: unknown) => setMessage({ text: authErrorMessage(error), error: true });
    try {
      const auth = createClient().auth;
      const next = nextPath();
      const callback = `${window.location.origin}/auth/callback${next === "/" ? "" : `?next=${encodeURIComponent(next)}`}`;
      if (mode === "magic-link") {
        const { error } = await auth.signInWithOtp({ email, options: { emailRedirectTo: callback } });
        if (error) fail(error); else emailSent();
      } else if (mode === "forgot") {
        const { error } = await auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/callback?next=/reset-password` });
        if (error) fail(error); else emailSent();
      } else {
        const { data, error } = mode === "sign-in"
          ? await auth.signInWithPassword({ email, password })
          : await auth.signUp({ email, password, options: { emailRedirectTo: callback } });
        if (error) fail(error);
        else if (data.session) { router.replace(next); router.refresh(); }
        // Only reached when the Supabase project still requires email confirmation.
        else emailSent();
      }
    } catch (error) {
      fail(error);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  function switchTo(next: Mode) {
    setMode(next);
    setMessage({ text: "" });
    // The button pressed may be gone now; the new heading is announced and the form follows it.
    requestAnimationFrame(() => heading.current?.focus());
  }

  const link = "min-h-11 underline hover:text-foreground lg:min-h-8";
  const input = "min-h-10 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";
  const usesPassword = mode === "sign-in" || mode === "sign-up";

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 sm:p-8">
        <div className="mb-8 flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-lime font-display text-[22px] font-bold tracking-tighter text-[#0f1011]">m</span><span className="font-display text-lg font-semibold tracking-tight">Moneo</span></div>
        <p className="mb-5 text-sm text-muted-foreground">See all your money in one place, import statements, plan ahead and ask questions. Your workspace is private, and Moneo can never move your money.</p>
        <p className="eyebrow">Your workspace</p>
        <h1 ref={heading} tabIndex={-1} className="mt-2 page-title outline-none">{copy[mode].title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{copy[mode].hint}</p>
        <form onSubmit={submit} hidden={message?.sent} className="mt-6 space-y-3">
          <label className="block text-sm font-medium" htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} className={input} />
          {usesPassword && <>
            <div className="flex items-baseline justify-between gap-3"><label className="block text-sm font-medium" htmlFor="password">Password</label>
              {mode === "sign-in" && <button type="button" disabled={pending} onClick={() => switchTo("forgot")} className="text-sm text-muted-foreground underline hover:text-foreground">Forgot password?</button>}</div>
            <PasswordInput id="password" autoComplete={mode === "sign-up" ? "new-password" : "current-password"} minLength={mode === "sign-up" ? 8 : undefined} required value={password} onChange={(event) => setPassword(event.target.value)} className={input} />
          </>}
          <button disabled={pending} className="min-h-10 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{pending ? "Working…" : copy[mode].button}</button>
        </form>
        {message?.error || (!message && failedCallback)
          ? <p role="alert" className="mt-4 rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger">{message?.text ?? "The sign-in link could not be verified. Request a new link and try again."}</p>
          : <p role="status" className="mt-4 min-h-5 text-sm text-muted-foreground">{message?.text ?? (deleted ? "Your account and data were deleted." : "")}</p>}
        {message?.sent && <div className="mt-2 space-y-3 text-sm">
          <p className="break-words text-muted-foreground">We sent it to <strong className="font-medium text-foreground">{email}</strong>. It can take a minute, and it may land in spam.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={pending || waiting} onClick={() => void submit({ preventDefault() {} })} className="min-h-10 rounded-lg border border-border px-3 font-medium hover:bg-muted disabled:opacity-50">{pending ? "Working…" : waiting ? "Sent. You can resend shortly" : "Send again"}</button>
            <button type="button" disabled={pending} onClick={() => setMessage({ text: "" })} className="min-h-10 rounded-lg px-3 underline hover:text-foreground">Use a different email</button>
          </div></div>}
        <div className="mt-4 flex flex-col items-center gap-2 text-sm text-muted-foreground">
          {mode !== "sign-in" && <button type="button" disabled={pending} onClick={() => switchTo("sign-in")} className={link}>Sign in with password</button>}
          {(mode === "sign-in" || mode === "magic-link") && <button type="button" disabled={pending} onClick={() => switchTo("sign-up")} className={link}>Create an account</button>}
          {mode === "sign-in" && <button type="button" disabled={pending} onClick={() => switchTo("magic-link")} className={link}>Email me a sign-in link</button>}
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground"><a href="/privacy" className={link}>Privacy</a><span aria-hidden="true"> · </span><a href="/terms" className={link}>Terms</a></p>
        {process.env.NODE_ENV === "development" && <form method="post" action="/auth/dev" className="mt-6 border-t border-border pt-6">
          <p className="eyebrow mb-2">Developer tools, local only</p>
          <input type="hidden" name="email" value={email} />
          <button disabled={!email} className="min-h-10 w-full rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">Sign in instantly (local dev)</button>
        </form>}
      </div>
    </main>
  );
}
