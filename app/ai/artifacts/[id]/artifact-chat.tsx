"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChatForm } from "@/app/ai/chat-form";
import { claimFirstPrompt } from "../actions";
import { ChatMessages, RESUMED_RUN, applyChatEvent, type ChatItem, type PendingExchange } from "@/components/chat-messages";
import { usePolling } from "@/lib/ai/use-polling";
import type { ChatAnswer, ChatStreamEvent } from "@/lib/ai/use-chat-request";
import type { ChatAttachment } from "@/lib/ai/chat-attachments";

type Loaded = { messages: ChatItem[]; messagesCursor: string | null; running?: string | null };
const SEND_EVENT = "moneo-artifact-send";

/** A paid request that takes a press: an empty Home cards tab, or a first request that failed. */
export function SendButton({ prompt, idle, label, sending }: { prompt: string; idle: string; label: string; sending: string }) {
  const [sent, setSent] = useState(false);
  return <span className="block space-y-3 text-sm text-muted-foreground">
    <span role="status" className="block">{sent ? sending : idle}</span>
    {!sent && <button type="button" onClick={() => { setSent(true); window.dispatchEvent(new CustomEvent(SEND_EVENT, { detail: prompt })); }}
      className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">{label}</button>}
  </span>;
}

/**
 * The artifact's own chat. It is a normal chat request (all chat tools, steering, cancel, the mic), so a build
 * keeps going when the tab closes and shows as working when the user comes back. A finished answer refreshes
 * the Page and Home card tabs beside it.
 */
export function ArtifactChat({ conversationId, initial, messagesCursor, running: initialRunning, artifactId }: { conversationId: string; initial: ChatItem[]; messagesCursor: string | null; running: string | null; artifactId?: string }) {
  const router = useRouter();
  const [messages, setMessages] = useState(initial);
  const [older, setOlder] = useState(messagesCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const prepended = useRef(false);
  const [running, setRunning] = useState(initialRunning);
  const [pending, setPending] = useState<PendingExchange | null>(null);
  const live = useRef<PendingExchange | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { if (prepended.current) { prepended.current = false; return; } if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages.length, pending]);
  const [request, setRequest] = useState<string>();
  const [claimFailed, setClaimFailed] = useState(false);
  const [claimAttempt, setClaimAttempt] = useState(0);
  useEffect(() => {
    const listener = (event: Event) => setRequest((event as CustomEvent<string>).detail);
    window.addEventListener(SEND_EVENT, listener);
    return () => window.removeEventListener(SEND_EVENT, listener);
  }, []);
  // The creation request, if this page is the first to claim it.
  useEffect(() => {
    if (!artifactId) return;
    // Nothing to claim means another page or a lost response took it; the refreshed page then offers Send it again.
    claimFirstPrompt(artifactId).then(prompt => { setClaimFailed(false); if (prompt) setRequest(prompt); else router.refresh(); }, () => setClaimFailed(true));
  }, [artifactId, claimAttempt, router]);

  // A build that kept running while the user was away: check until its answer is saved.
  const resuming = running && !pending;
  const [unreachable, setUnreachable] = useState(false);
  usePolling(() => void fetch(`/api/conversations/${conversationId}`, { cache: "no-store" }).then(response => { if (!response.ok) throw new Error(); return response.json() as Promise<Loaded>; }).then(data => {
    setUnreachable(false);
    if (data.running) return;
    setMessages(current => [...current.filter(message => !data.messages.some(item => item.id === message.id)), ...data.messages]); setRunning(null); router.refresh();
  }).catch(() => setUnreachable(true)), 3000, !!resuming);

  async function loadOlder() {
    if (!older || loadingOlder) return;
    setLoadingOlder(true); setHistoryError("");
    try {
      const response = await fetch(`/api/conversations/${conversationId}?${new URLSearchParams({ messagesBefore: older })}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load older messages. Try again.");
      const data = await response.json() as Loaded;
      prepended.current = true;
      setMessages(current => [...data.messages.filter(message => !current.some(item => item.id === message.id)), ...current]);
      setOlder(data.messagesCursor);
    } catch (cause) { setHistoryError(cause instanceof Error ? cause.message : "Could not load older messages. Try again."); }
    finally { setLoadingOlder(false); }
  }

  function onStart(_id: string, question: string, attachments: ChatAttachment[], spoken: boolean) { live.current = { question, attachments, tools: [], spoken }; setPending(live.current); }
  function onEvent(_id: string, event: ChatStreamEvent) {
    if (!live.current) return;
    const before = live.current;
    live.current = applyChatEvent(before, event);
    setPending(live.current);
    // A page or card just saved: show it without waiting for the whole answer.
    if (event.type === "tool" && event.state === "done" && ["write_page", "card_preset", "write_card", "remove_card"].includes(event.name ?? "")) router.refresh();
  }
  function onDone(_id: string, question: string, result: ChatAnswer | null, attachments: ChatAttachment[]) {
    const finished = live.current;
    live.current = null; setPending(null); setRequest(undefined);
    if (!result) return;
    const now = new Date().toISOString();
    setMessages(current => [...current,
      { id: `local-${crypto.randomUUID()}`, role: "user", content: question.trim(), created_at: now, attachments, spoken: finished?.spoken },
      ...(finished?.steers ?? []).map(content => ({ id: `local-${crypto.randomUUID()}`, role: "user" as const, content, created_at: now })),
      { id: `local-${crypto.randomUUID()}`, role: "assistant", content: result.answer, created_at: now, tools: finished?.tools.length ? finished.tools : result.toolsUsed, plan: finished?.plan }]);
    router.refresh();
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <div ref={scroll} aria-label="Artifact chat messages" className="relative min-h-0 flex-1 overflow-y-auto pr-1">
      {older && <button type="button" disabled={loadingOlder} onClick={() => void loadOlder()} className="mb-4 min-h-9 rounded-lg border border-border px-3 text-xs text-muted-foreground disabled:opacity-50">{loadingOlder ? "Loading older messages…" : "Older messages"}</button>}
      {historyError && <p role="alert" className="mb-3 text-sm text-danger">{historyError}</p>}
      {messages.length || pending || resuming ? <ChatMessages compact messages={messages} pending={pending ?? (resuming ? RESUMED_RUN : undefined)} />
        : <p className="text-sm text-muted-foreground">Describe what to build. Ask for a Home card any time, e.g. “add this to Home as a small card”.</p>}
    </div>
    {unreachable && resuming && <p role="alert" className="text-xs text-warning">Could not check on this build. It may still be running. Moneo keeps trying.</p>}
    {claimFailed && <p role="alert" className="text-sm text-danger">Could not start your request. <button type="button" onClick={() => setClaimAttempt(count => count + 1)} className="underline">Try again</button></p>}
    <ChatForm conversationId={conversationId} selectionKey={`moneo-artifact-${conversationId}`} autoSend={request} placeholder="Change the page or a card…" onStart={onStart} onEvent={onEvent} onDone={onDone} />
  </div>;
}
