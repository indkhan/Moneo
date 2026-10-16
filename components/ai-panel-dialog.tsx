"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChatRequest } from "@/lib/ai/use-chat-request";
import { ArrowUp, SquarePen, Square, X } from "lucide-react";
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

  const bubble = "ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-3xl bg-muted px-4 py-2.5 text-sm";
  const avatar = <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground" aria-hidden="true">M</span>;

  return <dialog ref={dialog} id="moneo-ai-panel" aria-label="AI assistant" onCancel={onClose} className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-md border-l border-border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/30">
    <div className="flex h-full flex-col">
      <header className="flex flex-row-reverse items-center gap-1 border-b border-border px-3 py-2.5">
        <button type="button" onClick={onClose} aria-label="Close AI assistant" className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" aria-hidden="true" /></button>
        <button type="button" disabled={busy || !selectionKey} onClick={() => { selectConversation(selectionKey, "new"); setQuestion(""); if (pathname === "/ai") { router.push("/ai?conversation=new"); router.refresh(); } }} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"><SquarePen className="size-4" aria-hidden="true" />New chat</button>
        <h2 className="mr-auto pl-2 text-base font-semibold">Ask Moneo</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5">
        {historyError && <div role="alert" className="text-sm"><p>{historyError}</p><button type="button" onClick={() => void load()} className="mt-2 underline">Try again</button></div>}
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading conversation...</p>}
        {older && !historyError && <button type="button" disabled={loading || busy} onClick={() => void load(older)} className="mx-auto mb-4 block text-sm text-muted-foreground hover:text-foreground">Older messages</button>}
        <div className="space-y-6">{!historyError && history.map(item => <article key={item.id}>{item.role === "user" ? <p className={bubble}>{item.content}</p> : <div className="flex min-w-0 gap-2.5">{avatar}<div className="min-w-0 flex-1"><AiMessage content={item.content} /></div></div>}</article>)}</div>
        {!history.length && !exchanges.length && !historyError && !loading && <div className="flex h-full flex-col items-center justify-center text-center"><h3 className="text-lg font-semibold">How can I help with your money?</h3><p className="mt-1 text-sm text-muted-foreground">Ask about this page, a transaction or a balance.</p><div className="mt-5 flex flex-wrap justify-center gap-2">{["What changed in my spending last month?", "Create a spending chart"].map(prompt => <button key={prompt} type="button" onClick={() => { setQuestion(prompt); document.getElementById("panel-question")?.focus(); }} className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">{prompt}</button>)}</div></div>}
        <div className="mt-6 space-y-6" aria-live="polite">{!historyError && exchanges.map((exchange, index) => <article key={index} className="min-w-0 space-y-6"><p className={bubble}>{exchange.question}</p><div className="flex min-w-0 gap-2.5">{avatar}<div className="min-w-0 flex-1"><AiToolActivity tools={exchange.tools} /><AiMessage content={exchange.answer} /></div></div></article>)}</div>
      </div>
      <div className="px-3 pb-3">
        <form onSubmit={ask} className="rounded-3xl border border-border bg-card p-2 shadow-sm focus-within:border-muted-foreground/40"><label htmlFor="panel-question" className="sr-only">Question</label>
          <textarea id="panel-question" rows={1} maxLength={4000} value={question} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Ask about this page…" className="block max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 text-sm [field-sizing:content] focus:outline-none" />
          <div className="flex items-center justify-between gap-3 pl-2.5"><span role={busy ? "status" : undefined} className="text-xs text-muted-foreground">{busy ? "Request running · waiting for response" : ""}</span>
            {busy ? <button type="button" onClick={() => void cancel()} aria-label="Stop" className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90"><Square className="size-3 fill-current" aria-hidden="true" /></button>
              : <button disabled={loading || !!historyError || !question.trim()} aria-label="Send" className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30"><ArrowUp className="size-4" aria-hidden="true" /></button>}</div>
        </form>
        {error && <p role="alert" className="mt-2 px-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {status === "canceled" && <p role="status" className="mt-2 px-2 text-sm text-muted-foreground">Canceled. Completed edits remain in transaction history.</p>}
        <Link href={historyError ? "/ai" : `/ai?conversation=${conversationId ?? "new"}`} onClick={onClose} className="mt-2 block text-center text-xs text-muted-foreground hover:text-foreground">Continue in AI workspace ↗</Link>
      </div>
    </div>
  </dialog>;
}
