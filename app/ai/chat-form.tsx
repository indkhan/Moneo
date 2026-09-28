"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ChatForm({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, requestId: crypto.randomUUID(), message }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not answer");
      setMessage("");
      router.push(`/ai?conversation=${conversationId}`);
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not answer"); }
    finally { setBusy(false); }
  }

  return <form onSubmit={submit} className="mt-6"><label htmlFor="question" className="text-sm font-medium">Ask about your finances</label>
    <textarea id="question" value={message} onChange={event => setMessage(event.target.value)} maxLength={4000} rows={3} className="mt-2 block w-full rounded-xl border border-border bg-card p-4 shadow-sm" placeholder="What changed in my spending last month?" />
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    <button disabled={busy} className="mt-3 rounded-lg bg-brand px-4 py-2 font-medium text-white hover:opacity-90 text-sm">{busy ? "Thinking…" : "Send"}</button>
  </form>;
}
