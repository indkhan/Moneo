"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatStreamEvent, useChatRequest } from "./use-chat-request";

export type QueuedMessage = { id: string; conversationId: string; message: string; steering?: boolean };

/** After a run ends: a failed queued send and steers the run never took go back to the front, in order. */
export function requeueAfterRun(queue: QueuedMessage[], failed: QueuedMessage | null): QueuedMessage[] {
  const untaken = queue.filter(item => item.steering).map(item => ({ ...item, steering: false }));
  const back = [...failed ? [failed] : [], ...untaken];
  return [...back, ...queue.filter(item => !item.steering)];
}

/** The next message to send in this conversation; steering messages are not sendable. */
export function nextQueued(queue: QueuedMessage[], conversationId: string) {
  return queue.find(item => item.conversationId === conversationId && !item.steering) ?? null;
}

/**
 * Messages sent while a reply runs wait here, per conversation, and send in order once it completes.
 * Steer injects one into the running reply at its next model step; the server's `steered` event says which it took.
 * `start` sends a message and returns false when it could not start, which leaves it queued.
 */
export function useChatQueue(chat: ReturnType<typeof useChatRequest>, conversationId: string, start: (message: string) => boolean) {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  // Steer ids the running model took; they are in the conversation and never re-queued.
  const consumed = useRef(new Set<string>());
  const sending = useRef<QueuedMessage | null>(null);
  const running = useRef(false);

  useEffect(() => {
    if (chat.busy) { running.current = true; return; }
    if (running.current) {
      running.current = false;
      const failed = chat.status === "failed" ? sending.current : null;
      sending.current = null;
      if (failed || queue.some(item => item.steering)) { setQueue(current => requeueAfterRun(current, failed)); return; }
    }
    if (chat.status !== "completed") return;
    const next = nextQueued(queue, conversationId);
    if (!next || !start(next.message)) return;
    sending.current = next;
    setQueue(current => current.filter(item => item.id !== next.id));
  }, [chat.busy, chat.status, queue, conversationId, start]);

  function enqueue(message: string) { setQueue(current => [...current, { id: crypto.randomUUID(), conversationId, message: message.trim() }]); }
  function remove(id: string) { setQueue(current => current.filter(item => item.id !== id)); }

  async function steer(item: QueuedMessage) {
    const requestId = chat.requestId();
    if (!requestId || item.steering || chat.conversationId !== item.conversationId) return;
    // Marked before the request, so a `steered` event that arrives first still finds it.
    setQueue(current => current.map(entry => entry.id === item.id ? { ...entry, steering: true } : entry));
    let accepted = false;
    try {
      const response = await fetch("/api/chat/steer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steerId: item.id, requestId, message: item.message }) });
      accepted = response.ok && (await response.json().catch(() => ({}))).accepted === true;
    } catch { /* left queued below */ }
    // An accepted steer stays steering until taken or its run ends; a refused one goes back to waiting.
    if (!accepted && !consumed.current.has(item.id)) setQueue(current => current.map(entry => entry.id === item.id ? { ...entry, steering: false } : entry));
  }

  /** Records the steers the server took so they leave the queue for good. */
  function withSteers(event: ChatStreamEvent): ChatStreamEvent {
    if (event.type !== "steered") return event;
    const ids = new Set(event.steers.map(steer => steer.id));
    for (const id of ids) consumed.current.add(id);
    setQueue(current => current.filter(item => !ids.has(item.id)));
    return event;
  }

  return { queue: queue.filter(item => item.conversationId === conversationId), enqueue, remove, steer, withSteers, canSteer: chat.busy && chat.conversationId === conversationId };
}
