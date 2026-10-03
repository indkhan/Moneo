"use client";

import { useEffect, useRef, useState } from "react";
import { useChatRequest } from "@/lib/ai/use-chat-request";
import { ArrowUp, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AiMessage } from "./ai-message";
import { AiToolActivity } from "./ai-tool-activity";

export function AiPanel() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<{ question: string; answer: string; tools: string[] }[]>([]);
  const pathname = usePathname();
  const { send, cancel, busy, error, status } = useChatRequest();

  async function ask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim() || busy) return;
    const id = conversationId ?? crypto.randomUUID();
    setConversationId(id);
    const context = { path: window.location.pathname + window.location.search };
    const result = await send({ conversationId: id, message: question, context });
    if (result) { setExchanges(current => [...current, { question, answer: result.answer, tools: result.toolsUsed ?? [] }]); setQuestion(""); }
  }

  return <>
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="moneo-ai-panel" className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"><Sparkles className="size-4" aria-hidden="true" />Ask Moneo</button>
    <dialog ref={dialog} id="moneo-ai-panel" aria-label="AI assistant" onCancel={() => setOpen(false)} className="ai-evidence fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-md overflow-y-auto overscroll-contain border-l border-border bg-card p-5 text-foreground shadow-xl backdrop:bg-black/40">
      <button type="button" onClick={() => setOpen(false)} aria-label="Close AI assistant" className="float-right rounded-lg border border-border p-2"><X className="size-4" aria-hidden="true" /></button><p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Evidence room / Context inspector</p><h2 className="mt-2 text-xl font-semibold">Ask Moneo</h2><p className="mt-1 text-xs text-muted-foreground">Your financial questions, without leaving this page.</p>
      <div className="my-5 rounded-lg border border-border bg-muted p-3 font-mono text-[10px] text-muted-foreground"><span className="text-foreground">Current page</span><p className="mt-1 break-all">{pathname}</p><p className="mt-2">Page context guides navigation; data access follows your permissions.</p></div>
      {!exchanges.length && <div className="my-7"><h3 className="text-lg font-semibold">A closer look at your money.</h3><p className="mt-2 text-sm text-muted-foreground">Find a transaction, explain a balance, or create a tool you can revisit.</p><div className="mt-4 flex flex-wrap gap-2">{["What changed in my spending last month?", "Create a spending chart"].map(prompt => <button key={prompt} type="button" onClick={() => { setQuestion(prompt); document.getElementById("panel-question")?.focus(); }} className="rounded-lg border border-border px-3 py-2 text-left text-xs">{prompt}</button>)}</div></div>}
      <div className="space-y-6" aria-live="polite">{exchanges.map((exchange, index) => <article key={index} className="min-w-0"><p className="ai-user-message mb-5 whitespace-pre-wrap text-sm">{exchange.question}</p><p className="mb-3 flex items-center gap-2 text-xs font-semibold"><span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">M</span>Moneo</p><AiToolActivity tools={exchange.tools} /><AiMessage content={exchange.answer} /></article>)}</div>
      <form onSubmit={ask} className="ai-composer mt-6"><label htmlFor="panel-question" className="text-xs text-muted-foreground">Question</label><textarea id="panel-question" rows={3} maxLength={4000} value={question} onChange={event => setQuestion(event.target.value)} placeholder="Ask about this page…" className="mt-2 w-full resize-y rounded p-2 text-sm" />
        {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
        {status === "canceled" && <p role="status" className="mt-2 text-sm">Canceled. Completed edits remain in transaction history.</p>}
        {busy && <button type="button" onClick={() => void cancel()} className="mt-3 mr-3 rounded border px-3 py-2 text-sm">Stop</button>}
        <div className="mt-3 flex items-center justify-between gap-3"><span role="status" className="font-mono text-[10px] text-muted-foreground">{busy ? "Request running · waiting for response" : "Code is displayed, never executed here"}</span><button disabled={busy || !question.trim()} aria-label="Send" className="rounded-lg bg-primary p-2 text-sm text-primary-foreground disabled:opacity-50"><ArrowUp className="size-4" aria-hidden="true" /></button></div></form>
      <Link href={`/ai?conversation=${conversationId ?? "new"}`} onClick={() => setOpen(false)} className="mt-5 block border-t border-border pt-4 text-xs text-brand">Continue in AI workspace ↗</Link>
    </dialog>
  </>;
}
