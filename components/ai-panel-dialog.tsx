"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChatRequest } from "@/lib/ai/use-chat-request";
import { ArrowUp, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AiMessage } from "./ai-message";
import { AiToolActivity } from "./ai-tool-activity";
import { selectConversation } from "@/lib/ai/selected-conversation";
import type { HistoryMessage } from "@/lib/ai/conversation-history";

export function AiPanelDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<{ question: string; answer: string; tools: string[] }[]>([]);
  const [history, setHistory] = useState<HistoryMessage[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectionKey, setSelectionKey] = useState("");
  const generation = useRef(0);
  const pathname = usePathname();
  const router = useRouter();
  const load = useCallback(async (cursor?: string) => {
    const run = ++generation.current;
    setLoading(true); setHistoryError("");
    try {
      const response = await fetch(`/api/conversations${cursor ? `?messagesBefore=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store" });
      const result = await response.json();
      if (run !== generation.current) return;
      if (result.selectionKey) setSelectionKey(result.selectionKey);
      if (!response.ok) throw new Error(result.error ?? "Could not load conversation");
      setConversationId(result.selected?.id ?? null);
      selectConversation(result.selectionKey, result.selected?.id ?? "new", false);
      setHistory(current => cursor ? [...result.messages, ...current] : result.messages);
      setOlder(result.messagesCursor);
      if (!cursor) setExchanges([]);
    } catch (cause) {
      if (run === generation.current) setHistoryError(cause instanceof Error ? cause.message : "Could not load conversation");
    } finally { if (run === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => { void load(); }, 0);
    const changed = () => { void load(); };
    window.addEventListener("moneo-conversation-change", changed);
    const counter = generation;
    return () => { window.clearTimeout(timer); ++counter.current; window.removeEventListener("moneo-conversation-change", changed); };
  }, [open, pathname, load]);
  const { send, cancel, busy, error, status } = useChatRequest();

  async function ask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim() || busy || loading || historyError) return;
    const id = conversationId ?? crypto.randomUUID();
    setConversationId(id);
    const context = { path: window.location.pathname + window.location.search };
    const selectionGeneration = generation.current;
    const result = await send({ conversationId: id, message: question, context });
    if (result && selectionGeneration === generation.current) { selectConversation(selectionKey, id); setExchanges(current => [...current, { question, answer: result.answer, tools: result.toolsUsed ?? [] }]); setQuestion(current => current === question ? "" : current); if (pathname === "/ai") { router.push(`/ai?conversation=${id}`); router.refresh(); } }
  }

  return <dialog ref={dialog} id="moneo-ai-panel" aria-label="AI assistant" onCancel={onClose} className="ai-evidence fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-md overflow-y-auto overscroll-contain border-l border-border bg-card p-5 text-foreground shadow-xl backdrop:bg-black/40">
      <button type="button" onClick={onClose} aria-label="Close AI assistant" className="float-right rounded-lg border border-border p-2"><X className="size-4" aria-hidden="true" /></button><p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Evidence room / Context inspector</p><h2 className="mt-2 text-xl font-semibold">Ask Moneo</h2><p className="mt-1 text-xs text-muted-foreground">Your financial questions, without leaving this page.</p>
      <div className="my-5 rounded-lg border border-border bg-muted p-3 font-mono text-[10px] text-muted-foreground"><span className="text-foreground">Current page</span><p className="mt-1 break-all">{pathname}</p><p className="mt-2">Page context guides navigation; data access follows your permissions.</p></div>
      <button type="button" disabled={busy || !selectionKey} onClick={() => { selectConversation(selectionKey, "new"); setQuestion(""); if (pathname === "/ai") { router.push("/ai?conversation=new"); router.refresh(); } }} className="my-3 text-sm underline">New conversation</button>
      {historyError && <div role="alert"><p>{historyError}</p><button type="button" onClick={() => void load()}>Try again</button></div>}
      {loading && <p role="status">Loading conversation...</p>}
      {older && !historyError && <button type="button" disabled={loading || busy} onClick={() => void load(older)} className="my-3 text-sm underline">Older messages</button>}
      {!historyError && history.map(item => <article key={item.id} className="my-5"><p className="mb-2 text-xs font-semibold">{item.role === "user" ? "You" : "Moneo"}</p>{item.role === "user" ? <p className="ai-user-message whitespace-pre-wrap text-sm">{item.content}</p> : <AiMessage content={item.content} />}</article>)}
      {!history.length && !exchanges.length && !historyError && !loading && <div className="my-7"><h3 className="text-lg font-semibold">A closer look at your money.</h3><p className="mt-2 text-sm text-muted-foreground">Find a transaction, explain a balance, or create a tool you can revisit.</p><div className="mt-4 flex flex-wrap gap-2">{["What changed in my spending last month?", "Create a spending chart"].map(prompt => <button key={prompt} type="button" onClick={() => { setQuestion(prompt); document.getElementById("panel-question")?.focus(); }} className="rounded-lg border border-border px-3 py-2 text-left text-xs">{prompt}</button>)}</div></div>}
      <div className="space-y-6" aria-live="polite">{!historyError && exchanges.map((exchange, index) => <article key={index} className="min-w-0"><p className="ai-user-message mb-5 whitespace-pre-wrap text-sm">{exchange.question}</p><p className="mb-3 flex items-center gap-2 text-xs font-semibold"><span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">M</span>Moneo</p><AiToolActivity tools={exchange.tools} /><AiMessage content={exchange.answer} /></article>)}</div>
      <form onSubmit={ask} className="ai-composer mt-6"><label htmlFor="panel-question" className="text-xs text-muted-foreground">Question</label><textarea id="panel-question" rows={3} maxLength={4000} value={question} onChange={event => setQuestion(event.target.value)} placeholder="Ask about this page…" className="mt-2 w-full resize-y rounded p-2 text-sm" />
        {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
        {status === "canceled" && <p role="status" className="mt-2 text-sm">Canceled. Completed edits remain in transaction history.</p>}
        {busy && <button type="button" onClick={() => void cancel()} className="mt-3 mr-3 rounded border px-3 py-2 text-sm">Stop</button>}
        <div className="mt-3 flex items-center justify-between gap-3"><span role={busy ? "status" : undefined} className="font-mono text-[10px] text-muted-foreground">{busy ? "Request running · waiting for response" : "Code is displayed, never executed here"}</span><button disabled={busy || loading || !!historyError || !question.trim()} aria-label="Send" className="rounded-lg bg-primary p-2 text-sm text-primary-foreground disabled:opacity-50"><ArrowUp className="size-4" aria-hidden="true" /></button></div></form>
      <Link href={historyError ? "/ai" : `/ai?conversation=${conversationId ?? "new"}`} onClick={onClose} className="mt-5 block border-t border-border pt-4 text-xs text-brand">Continue in AI workspace ↗</Link>
    </dialog>;
}
