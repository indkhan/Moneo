"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { error } = await createClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setMessage(error?.message ?? "Check your email for the sign-in link.");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-sm">
        <div className="mb-10 flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-lg bg-primary text-lg font-bold text-primary-foreground">M</span><span className="text-lg font-semibold tracking-tight">Moneo</span></div>
        <p className="text-xs font-semibold uppercase tracking-widest text-brand">Your workspace</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Sign in to Moneo</h1>
        <p className="mt-2 text-sm text-muted-foreground">Enter your email to receive a sign-in link.</p>
        <form onSubmit={signIn} className="mt-8 space-y-3">
          <label className="block text-sm font-medium" htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="w-full rounded-lg border border-border bg-card px-3 py-2.5 outline-none focus:border-brand focus:ring-2 focus:ring-blue-100" />
          <button className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90">Send sign-in link</button>
        </form>
        <p role="status" className="mt-4 text-sm text-muted-foreground">{message}</p>
      </div>
    </main>
  );
}
