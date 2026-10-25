"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase-client";

// Reached from the password-reset email (signed in via /auth/callback). Any
// signed-in user, including magic-link-only accounts, can set a password here.
export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const { error } = await createClient().auth.updateUser({ password });
      if (error) setMessage(error.message);
      else { router.replace("/"); router.refresh(); }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the password. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8">
        <h1 className="page-title">Set a new password</h1>
        <form onSubmit={save} className="mt-6 space-y-3">
          <label className="block text-sm font-medium" htmlFor="password">New password</label>
          <input id="password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} className="min-h-10 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20" />
          <button disabled={pending} className="min-h-10 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{pending ? "Saving…" : "Save password"}</button>
        </form>
        <p role="status" className="mt-4 min-h-5 text-sm text-muted-foreground">{message}</p>
      </div>
    </main>
  );
}
