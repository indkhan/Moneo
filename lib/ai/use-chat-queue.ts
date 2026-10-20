"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatStreamEvent, useChatRequest } from "./use-chat-request";

export type QueuedMessage = { id: string; message: string; steering?: boolean };

/**
 * Messages sent while a reply runs wait here and send in order once it completes.
 * Steer injects one into the running reply at its next model step; if that run ends first, it stays queued.
 */
export function useChatQueue(chat: ReturnType<typeof useChatRequest>, dispatch: (message: string) => void) {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  // Steers the server accepted for a request but the model has not taken yet.
  const steering = useRef<{ requestId: string; item: QueuedMessage }[]>([]);

  useEffect(() => {
    if (chat.busy) return;
    // The run ended: steers it never reached go first in the queue.
    const unsent = steering.current.map(entry => ({ ...entry.item, steering: false }));
    steering.current = [];
    if (unsent.length) { setQueue(current => [...unsent, ...current]); return; }
    if (chat.status !== "completed" || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    dispatch(next.message);
  }, [chat.busy, chat.status, queue, dispatch]);

  function enqueue(message: string) { setQueue(current => [...current, { id: crypto.randomUUID(), message: message.trim() }]); }
  function remove(id: string) { setQueue(current => current.filter(item => item.id !== id)); }
  const mark = (id: string, value: boolean) => setQueue(current => current.map(item => item.id === id ? { ...item, steering: value } : item));

  async function steer(item: QueuedMessage) {
    const requestId = chat.requestId();
    if (!requestId || item.steering) return;
    mark(item.id, true);
    try {
      const response = await fetch("/api/chat/steer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steerId: item.id, requestId, message: item.message }) });
      const result = await response.json().catch(() => ({}));
      // A finished or unknown run leaves the message queued to send next.
      if (!response.ok || !result.accepted || chat.requestId() !== requestId) return mark(item.id, false);
      steering.current.push({ requestId, item });
      remove(item.id);
    } catch { mark(item.id, false); }
  }

  /** Adds the steered messages' text to a `steered` stream event so the transcript can show them. */
  function withSteers(event: ChatStreamEvent): ChatStreamEvent {
    if (event.type !== "steered") return event;
    const taken = steering.current.filter(entry => event.ids.includes(entry.item.id));
    steering.current = steering.current.filter(entry => !taken.includes(entry));
    return { ...event, messages: taken.map(entry => entry.item.message) };
  }

  return { queue, enqueue, remove, steer, withSteers };
}
