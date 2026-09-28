"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";

export function AiPanel() {
  const [open, setOpen] = useState(false);
  const [conversationId] = useState(() => crypto.randomUUID());
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function ask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim() || busy) return;
    const context = { path: window.location.pathname + window.location.search };
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, requestId: crypto.randomUUID(), message: question, context }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not answer");
      setAnswer(result.answer);
      setQuestion("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not answer"); }
    finally { setBusy(false); }
  }

  return <>
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="moneo-ai-panel" className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"><Sparkles className="size-4" aria-hidden="true" />Ask Moneo</button>
    {open && <aside id="moneo-ai-panel" aria-label="AI assistant" className="fixed inset-y-0 right-0 z-30 w-full max-w-sm overflow-y-auto border-l border-border bg-card p-6 pb-20 shadow-xl">
      <h2 className="text-xl font-semibold">Ask Moneo</h2><p className="mt-1 text-sm text-muted-foreground">I can look up your current financial data.</p>
      {answer && <p className="mt-6 whitespace-pre-wrap rounded border p-3 text-sm">{answer}</p>}
      <form onSubmit={ask} className="mt-6"><label htmlFor="panel-question" className="text-sm">Question</label><textarea id="panel-question" rows={4} maxLength={4000} value={question} onChange={event => setQuestion(event.target.value)} className="mt-2 w-full rounded border p-2" />
        {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        <button disabled={busy} className="mt-3 rounded bg-primary px-4 py-2 text-sm text-primary-foreground">{busy ? "Thinking…" : "Send"}</button></form>
    </aside>}
  </>;
}
