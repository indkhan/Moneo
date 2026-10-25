"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChatRequest } from "@/lib/ai/use-chat-request";
import { SquarePen, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useChatQueue } from "@/lib/ai/use-chat-queue";
import { ChatComposer } from "./chat-composer";
import { ChatQueue } from "./chat-queue";
import { ChatMessages, DRAFT_EVENT, applyChatEvent, type ChatItem, type PendingExchange } from "./chat-messages";
import { selectConversation } from "@/lib/ai/selected-conversation";
import type { AskSeed } from "./ask-about";

export function AiPanelDialog({ open, onClose, seed }: { open: boolean; onClose: () => void; seed?: (AskSeed & { nonce: number }) | null }) {
  // Non-modal: the page behind stays usable while the panel is open.
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.show();
    else dialog.current?.close();
  }, [open]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  // "Ask about this" drafts the question and attaches what it is about; the user still sends it.
  const [about, setAbout] = useState<AskSeed["about"] | null>(null);
  const [seenSeed, setSeenSeed] = useState<number | null>(null);
  if (seed && seed.nonce !== seenSeed) { setSeenSeed(seed.nonce); setQuestion(seed.question); setAbout(seed.about ?? null); }
  const [pending, setPending] = useState<PendingExchange | null>(null);
  const [history, setHistory] = useState<ChatItem[]>([]);
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
  }, [open, load]);
  const chat = useChatRequest();
  const { send, cancel, busy, error, status } = chat;
  useEffect(() => {
    const draft = (event: Event) => { const detail = (event as CustomEvent<{ prompt?: string; compact: boolean }>).detail; if (detail.compact && detail.prompt) { setQuestion(detail.prompt); document.getElementById("panel-question")?.focus(); } };
    window.addEventListener(DRAFT_EVENT, draft);
    return () => window.removeEventListener(DRAFT_EVENT, draft);
  }, []);

  function ask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim() || loading || historyError) return;
    if (busy) { enqueue(question); setQuestion(""); return; }
    void sendMessage(question);
  }

  async function sendMessage(question: string, queued = false) {
    if (busy || loading || historyError) return;
    const id = conversationId ?? crypto.randomUUID();
    setConversationId(id);
    const context = { path: window.location.pathname + window.location.search, ...(about ? { about } : {}) };
    const selectionGeneration = generation.current;
    let live: PendingExchange = { question, tools: [] };
    setPending(live);
    if (!queued) setQuestion("");
    const result = await send({ conversationId: id, message: question, context }, event => { live = applyChatEvent(live, withSteers(event)); setPending(live); });
    setPending(null);
    if (result && selectionGeneration === generation.current) {
      selectConversation(selectionKey, id);
      const now = new Date().toISOString();
      setHistory(current => [...current, { id: `local-${crypto.randomUUID()}`, role: "user", content: question.trim(), created_at: now },
        ...(live.steers ?? []).map(content => ({ id: `local-${crypto.randomUUID()}`, role: "user" as const, content, created_at: now })), { id: `local-${crypto.randomUUID()}`, role: "assistant", content: result.answer, created_at: now, tools: live.tools.length ? live.tools : result.toolsUsed, plan: live.plan, followUps: result.followUps }]);
      setAbout(null);
      // The AI page keeps its own client state; refresh it only when it is the page behind the panel.
      if (pathname === "/ai") { router.push(`/ai?conversation=${id}`); router.refresh(); }
    } else if (!result && !queued) setQuestion(current => current || question);
  }

  // A queued message that fails goes back to the queue, so the composer keeps what the user is typing.
  function startQueued(message: string) {
    if (busy || loading || historyError) return false;
    void sendMessage(message, true);
    return true;
  }
  const { queue, enqueue, remove, steer, withSteers, canSteer } = useChatQueue(chat, conversationId ?? "", startQueued);

  return <dialog ref={dialog} id="moneo-ai-panel" aria-label="AI assistant" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }} className="fixed inset-y-0 right-0 left-auto z-40 m-0 h-dvh max-h-none w-full max-w-md border-l border-border bg-background p-0 text-foreground shadow-xl">
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
        {!historyError && <ChatMessages compact messages={history} pending={pending} />}
        {!history.length && !pending && !historyError && !loading && <div className="flex h-full flex-col items-center justify-center text-center"><h3 className="text-lg font-semibold">How can I help with your money?</h3><p className="mt-1 text-sm text-muted-foreground">Ask about this page, a transaction or a balance.</p><div className="mt-5 flex flex-wrap justify-center gap-2">{["What changed in my spending last month?", "Create a spending chart"].map(prompt => <button key={prompt} type="button" onClick={() => { setQuestion(prompt); document.getElementById("panel-question")?.focus(); }} className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">{prompt}</button>)}</div></div>}
      </div>
      <div className="px-3 pb-3">
        {about && <p className="mb-2 flex items-center gap-2 px-2 text-xs text-muted-foreground">About: <span className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-foreground">{about.label}</span><button type="button" onClick={() => setAbout(null)} aria-label="Remove context" className="hover:text-foreground"><X className="size-3" aria-hidden="true" /></button></p>}
        <ChatQueue items={queue} canSteer={canSteer} onSteer={item => void steer(item)} onRemove={remove} />
        <ChatComposer compact id="panel-question" label="Question" value={question} onChange={setQuestion} onSubmit={ask} onStop={() => void cancel()} busy={busy} disabled={loading || !!historyError} placeholder="Ask about this page…" busyText="Request running · waiting for response" />
        {error && <p role="alert" className="mt-2 px-2 text-sm text-danger">{error}</p>}
        {status === "canceled" && <p role="status" className="mt-2 px-2 text-sm text-muted-foreground">Canceled. Completed edits remain in transaction history.</p>}
        <Link href={historyError ? "/ai" : `/ai?conversation=${conversationId ?? "new"}`} onClick={onClose} className="mt-2 block text-center text-xs text-muted-foreground hover:text-foreground">Continue in AI workspace ↗</Link>
      </div>
    </div>
  </dialog>;
}
