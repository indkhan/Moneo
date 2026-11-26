"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChatForm } from "@/components/chat-form";
import { claimFirstPrompt } from "../actions";
import { ChatMessages, RESUMED_RUN, applyChatEvent, localExchange, type ChatItem, type PendingExchange } from "@/components/chat-messages";
import { useChatPath } from "@/lib/ai/use-chat-path";
import { useAiAccess } from "@/lib/ai/use-ai-access";
import type { ChatNode } from "@/lib/ai/chat-tree";
import { usePolling } from "@/lib/use-polling";
import { SavedVersion, savedVersion, type HomeVersions } from "./saved-version";
import type { ChatAnswer, ChatStreamEvent } from "@/lib/ai/use-chat-request";
import type { ChatAttachment } from "@/lib/ai/chat-attachments";

type Loaded = { messages: ChatItem[]; requests?: ChatNode[]; messagesCursor: string | null; running?: string | null };
const SEND_EVENT = "moneo-artifact-send";

export function SendButton({ prompt, idle, label, sending }: { prompt: string; idle: string; label: string; sending: string }) {
  const [sent, setSent] = useState(false);
  return <span className="block space-y-3 text-sm text-muted-foreground">
    <span role="status" className="block">{sent ? sending : idle}</span>
    {!sent && <button type="button" onClick={() => { setSent(true); window.dispatchEvent(new CustomEvent(SEND_EVENT, { detail: prompt })); }}
      className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">{label}</button>}
  </span>;
}

export function ArtifactChat({ conversationId, initial, requests: initialRequests, end, model, messagesCursor, running: initialRunning, artifactId, artifact, home }: { conversationId: string; initial: ChatItem[]; requests: ChatNode[]; end: string | null; model: string | null; messagesCursor: string | null; running: string | null; artifactId?: string; artifact: string; home: HomeVersions }) {
  const router = useRouter();
  const search = useSearchParams();
  const [messages, setMessages] = useState(initial);
  const [requests, setRequests] = useState(initialRequests);
  const branch = useChatPath(requests, end);
  const shownEnd = useRef(branch.end);
  const show = (changes: Record<string, string | null>) => {
    const params = new URLSearchParams(search);
    for (const [name, value] of Object.entries(changes)) if (value === null) params.delete(name); else params.set(name, value);
    router.replace(`?${params}`, { scroll: false });
  };
  useEffect(() => {
    if (!branch.end || branch.end === shownEnd.current) return;
    shownEnd.current = branch.end;
    show({ branch: branch.end, v: null, cv: null });
  });
  const access = useAiAccess();
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
  useEffect(() => {
    if (!artifactId) return;
    claimFirstPrompt(artifactId).then(prompt => { setClaimFailed(false); if (prompt) setRequest(prompt); else router.refresh(); }, () => setClaimFailed(true));
  }, [artifactId, claimAttempt, router]);

  const resuming = running && !pending;
  const [unreachable, setUnreachable] = useState(false);
  usePolling(signal => fetch(`/api/conversations/${conversationId}`, { cache: "no-store", signal }).then(response => { if (!response.ok) throw new Error(); return response.json() as Promise<Loaded>; }).then(data => {
    setUnreachable(false);
    if (data.running) return;
    setMessages(current => [...current.filter(message => !data.messages.some(item => item.id === message.id)), ...data.messages]); if (data.requests) setRequests(data.requests); setRunning(null); router.refresh();
  }).catch(() => { if (!signal.aborted) setUnreachable(true); }), 3000, !!resuming);

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

  function onStart(_id: string, question: string, attachments: ChatAttachment[], spoken: boolean, after?: string | null) { live.current = { question, attachments, tools: [], spoken, after }; setPending(live.current); }
  function onEvent(_id: string, event: ChatStreamEvent) {
    if (!live.current) return;
    const before = live.current;
    live.current = applyChatEvent(before, event);
    setPending(live.current);
    if (event.type !== "tool" || event.state !== "done") return;
    const saved = savedVersion({ name: event.name, state: event.state, output: event.output, input: event.input });
    if (saved?.kind === "page") show({ v: String(saved.version) });
    else if (saved?.kind === "card") show({ card: saved.cardId, cv: String(saved.version) });
    else if (event.name === "remove_card") router.refresh();
  }
  function onDone(_id: string, question: string, result: (ChatAnswer & { requestId: string }) | null, attachments: ChatAttachment[]) {
    const finished = live.current ?? undefined;
    live.current = null; setPending(null); setRequest(undefined);
    if (!result) return;
    const exchange = localExchange(question, result, finished, attachments);
    setMessages(current => [...current, ...exchange.messages]);
    setRequests(current => [...current, exchange.node]);
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <div ref={scroll} aria-label="Artifact chat messages" className="relative min-h-0 flex-1 overflow-y-auto pr-1">
      {older && <button type="button" disabled={loadingOlder} onClick={() => void loadOlder()} className="mb-4 min-h-9 rounded-lg border border-border px-3 text-xs text-muted-foreground disabled:opacity-50">{loadingOlder ? "Loading older messages…" : "Older messages"}</button>}
      {historyError && <p role="alert" className="mb-3 text-sm text-danger">{historyError}</p>}
      {messages.length || pending || resuming ? <ChatMessages compact messages={messages} path={branch.path} onPick={branch.pick} editable models={access?.models} pending={pending ?? (resuming ? RESUMED_RUN : undefined)} toolResult={(step, key, regenerate) => <SavedVersion key={key} step={step} artifactId={artifact} home={home} regenerate={regenerate} models={access?.models ?? []} />} />
        : <p className="text-sm text-muted-foreground">Describe what to build. Ask for a Home card any time, e.g. “add this to Home as a small card”.</p>}
    </div>
    {unreachable && resuming && <p role="alert" className="text-xs text-warning">Could not check on this build. It may still be running. Moneo keeps trying.</p>}
    {claimFailed && <p role="alert" className="text-sm text-danger">Could not start your request. <button type="button" onClick={() => setClaimAttempt(count => count + 1)} className="underline">Try again</button></p>}
    <ChatForm conversationId={conversationId} selectionKey={`moneo-artifact-${conversationId}`} autoSend={request} placeholder="Change the page or a card…" parent={branch.end} model={model} persisted agent="artifacts" onStart={onStart} onEvent={onEvent} onDone={onDone} />
  </div>;
}
