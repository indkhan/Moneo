"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChatForm } from "@/app/ai/chat-form";
import { ChatMessages, RESUMED_RUN, applyChatEvent, type ChatItem, type PendingExchange } from "@/components/chat-messages";
import { usePolling } from "@/lib/ai/use-polling";
import type { ChatAnswer, ChatStreamEvent } from "@/lib/ai/use-chat-request";
import type { ChatAttachment } from "@/lib/ai/chat-attachments";

type Loaded = { messages: ChatItem[]; running?: string | null };

/**
 * The artifact's own chat. It is a normal chat request (all chat tools, steering, cancel, the mic), so a build
 * keeps going when the tab closes and shows as working when the user comes back. A finished answer refreshes
 * the Page and Home card tabs beside it.
 */
export function ArtifactChat({ conversationId, initial, running: initialRunning, start }: { conversationId: string; initial: ChatItem[]; running: string | null; start?: string }) {
  const router = useRouter();
  const [messages, setMessages] = useState(initial);
  const [running, setRunning] = useState(initialRunning);
  const [pending, setPending] = useState<PendingExchange | null>(null);
  const live = useRef<PendingExchange | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages.length, pending]);
  // The first request came in the URL; drop it so a reload doesn't send it again.
  useEffect(() => {
    if (!start) return;
    const url = new URL(window.location.href); url.searchParams.delete("start"); window.history.replaceState(null, "", url);
  }, [start]);

  // A build that kept running while the user was away: check until its answer is saved.
  const resuming = running && !pending;
  usePolling(() => void fetch(`/api/conversations/${conversationId}`, { cache: "no-store" }).then(response => response.ok ? response.json() as Promise<Loaded> : null).then(data => {
    if (!data || data.running) return;
    setMessages(data.messages); setRunning(null); router.refresh();
  }).catch(() => {}), 3000, !!resuming);

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
    live.current = null; setPending(null);
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
      {messages.length || pending || resuming ? <ChatMessages compact messages={messages} pending={pending ?? (resuming ? RESUMED_RUN : undefined)} />
        : <p className="text-sm text-muted-foreground">Describe what to build. Ask for a Home card any time, e.g. “add this to Home as a small card”.</p>}
    </div>
    <ChatForm conversationId={conversationId} selectionKey={`moneo-artifact-${conversationId}`} autoSend={start} placeholder="Change the page or a card…" onStart={onStart} onEvent={onEvent} onDone={onDone} />
  </div>;
}
