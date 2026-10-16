"use client";

import { useEffect, useState } from "react";
import { selectConversation } from "@/lib/ai/selected-conversation";
import { useChatRequest, type ChatAnswer, type ChatStreamEvent } from "@/lib/ai/use-chat-request";
import { ChatComposer } from "@/components/chat-composer";
import { DRAFT_EVENT } from "@/components/chat-messages";

const suggestions = ["What changed in my spending last month?", "Where did most of my money go this month?", "Find my largest transactions", "Create a spending chart"];

export type ChatFormEvents = {
  onStart?: (conversationId: string, question: string) => void;
  onEvent?: (conversationId: string, event: ChatStreamEvent) => void;
  onDone?: (conversationId: string, question: string, result: ChatAnswer | null) => void;
};

// The composer keeps its key when a new chat is first saved, so a draft typed during the answer stays put.
export function ChatForm({ conversationId, selectionKey, empty = false, scope, onStart, onEvent, onDone }: { conversationId: string; selectionKey: string; isNewConversation?: boolean; empty?: boolean; scope?: React.ReactNode } & ChatFormEvents) {
  const [message, setMessage] = useState("");
  const { send, cancel, busy, error, status } = useChatRequest();
  useEffect(() => {
    const draft = (event: Event) => { const detail = (event as CustomEvent<{ prompt?: string; compact: boolean }>).detail; if (!detail.compact && detail.prompt) { setMessage(detail.prompt); document.getElementById("question")?.focus(); } };
    window.addEventListener(DRAFT_EVENT, draft);
    return () => window.removeEventListener(DRAFT_EVENT, draft);
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim() || busy) return;
    onStart?.(conversationId, message);
    const result = await send({ conversationId, message }, streamed => onEvent?.(conversationId, streamed));
    if (result) {
      selectConversation(selectionKey, conversationId);
      setMessage(current => current === message ? "" : current);
    }
    onDone?.(conversationId, message, result);
  }

  const composer = <ChatComposer id="question" label="Ask about your finances" value={message} onChange={setMessage} onSubmit={submit} onStop={() => void cancel()} busy={busy} placeholder="Ask anything about your money" busyText="Waiting for a response…" />;
  const notices = <>{error && <p role="alert" className="mt-2 px-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    {status === "canceled" && <p role="status" className="mt-2 px-3 text-sm text-muted-foreground">Canceled. Previously completed edits remain in transaction history.</p>}</>;

  if (empty) return <div className="flex flex-1 flex-col justify-center py-10">
    <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">How can I help with your money today?</h2>
    <div className="mt-8">{composer}{notices}</div>
    <div className="mt-4 flex flex-wrap justify-center gap-2">{suggestions.map(prompt => <button key={prompt} type="button" onClick={() => { setMessage(prompt); document.getElementById("question")?.focus(); }} className="rounded-full border border-border px-3.5 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">{prompt}</button>)}</div>
    {scope}
  </div>;

  return <div className="sticky bottom-0 mt-auto bg-gradient-to-t from-background from-70% to-transparent pt-6 pb-4">{composer}{notices}{scope}</div>;
}
