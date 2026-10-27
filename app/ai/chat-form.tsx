"use client";

import { useEffect, useState } from "react";
import { selectConversation } from "@/lib/ai/selected-conversation";
import { useChatRequest, type ChatAnswer, type ChatStreamEvent } from "@/lib/ai/use-chat-request";
import { useChatQueue } from "@/lib/ai/use-chat-queue";
import { useChatAttachments } from "@/lib/ai/use-chat-attachments";
import { ATTACHMENT_ONLY_MESSAGE, type ChatAttachment } from "@/lib/ai/chat-attachments";
import { ChatComposer } from "@/components/chat-composer";
import { ChatQueue } from "@/components/chat-queue";
import { DRAFT_EVENT } from "@/components/chat-messages";

const suggestions = ["What changed in my spending last month?", "Where did most of my money go this month?", "Find my largest transactions", "Create a spending chart"];

export type ChatFormEvents = {
  onStart?: (conversationId: string, question: string, attachments: ChatAttachment[]) => void;
  onEvent?: (conversationId: string, event: ChatStreamEvent) => void;
  onDone?: (conversationId: string, question: string, result: ChatAnswer | null, attachments: ChatAttachment[]) => void;
};

// The composer keeps its key when a new chat is first saved, so a draft typed during the answer stays put.
export function ChatForm({ conversationId, selectionKey, empty = false, scope, onStart, onEvent, onDone }: { conversationId: string; selectionKey: string; isNewConversation?: boolean; empty?: boolean; scope?: React.ReactNode } & ChatFormEvents) {
  const [message, setMessage] = useState("");
  const chat = useChatRequest();
  const files = useChatAttachments();
  const { send, cancel, busy, error, status } = chat;
  useEffect(() => {
    const draft = (event: Event) => { const detail = (event as CustomEvent<{ prompt?: string; compact: boolean }>).detail; if (!detail.compact && detail.prompt) { setMessage(detail.prompt); document.getElementById("question")?.focus(); } };
    window.addEventListener(DRAFT_EVENT, draft);
    return () => window.removeEventListener(DRAFT_EVENT, draft);
  }, []);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim() && !files.ready.length) return;
    // Files go with the next message the user sends themselves, never with a queued one.
    if (busy) { if (files.items.length) return; enqueue(message); setMessage(""); return; }
    void sendMessage(message, false, files.ready);
  }

  async function sendMessage(typed: string, queued = false, attachments: ChatAttachment[] = []) {
    if (busy) return;
    const message = typed.trim() || ATTACHMENT_ONLY_MESSAGE;
    onStart?.(conversationId, message, attachments);
    if (!queued) { setMessage(""); files.clear(); }
    const result = await send({ conversationId, message, ...(attachments.length && { attachments }) }, streamed => onEvent?.(conversationId, withSteers(streamed)));
    if (result) {
      selectConversation(selectionKey, conversationId);
    } else if (!queued) { setMessage(current => current || typed); files.restore(attachments); }
    onDone?.(conversationId, message, result, attachments);
  }

  // A queued message that fails goes back to the queue, so the composer keeps what the user is typing.
  function startQueued(next: string) {
    if (busy) return false;
    void sendMessage(next, true);
    return true;
  }
  const { queue, enqueue, remove, steer, withSteers, canSteer } = useChatQueue(chat, conversationId, startQueued);

  const composer = <><ChatQueue items={queue} canSteer={canSteer} onSteer={item => void steer(item)} onRemove={remove} /><ChatComposer id="question" label="Ask about your finances" value={message} onChange={setMessage} onSubmit={submit} onStop={() => void cancel()} busy={busy} placeholder="Ask anything about your money" busyText="Waiting for a response…" attachments={files} /></>;
  const notices = <>{error && <p role="alert" className="mt-2 px-3 text-sm text-danger">{error}</p>}
    {status === "canceled" && <p role="status" className="mt-2 px-3 text-sm text-muted-foreground">Canceled. Previously completed edits remain in transaction history.</p>}</>;

  if (empty) return <div className="flex flex-1 flex-col justify-center py-10">
    <h2 className="text-center font-display text-3xl font-semibold tracking-tight sm:text-4xl">How can I help with your money today?</h2>
    <div className="mt-8">{composer}{notices}</div>
    <div className="mt-4 flex flex-wrap justify-center gap-2">{suggestions.map(prompt => <button key={prompt} type="button" onClick={() => { setMessage(prompt); document.getElementById("question")?.focus(); }} className="rounded-full border border-border px-3.5 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">{prompt}</button>)}</div>
    {scope}
  </div>;

  return <div className="sticky bottom-0 mt-auto bg-gradient-to-t from-background from-70% to-transparent pt-6 pb-4">{composer}{notices}{scope}</div>;
}
