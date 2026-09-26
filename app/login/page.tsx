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
    <main className="mx-auto max-w-sm px-6 py-24">
      <h1 className="text-3xl font-semibold">Sign in to Moneo</h1>
      <form onSubmit={signIn} className="mt-8 space-y-4">
        <label className="block text-sm" htmlFor="email">Email</label>
        <input id="email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="w-full rounded border p-2" />
        <button className="rounded bg-primary px-4 py-2 text-primary-foreground">Send sign-in link</button>
      </form>
      <p role="status" className="mt-4 text-sm">{message}</p>
    </main>
  );
}
