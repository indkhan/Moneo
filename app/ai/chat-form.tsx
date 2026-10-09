"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { selectConversation } from "@/lib/ai/selected-conversation";

import { useChatRequest } from "@/lib/ai/use-chat-request";
import { AiToolActivity } from "@/components/ai-tool-activity";

// First-send navigation remounts the composer under its saved conversation key.
// Carry only that pending draft in memory until the new composer mounts.
let carriedDraft: { conversationId: string; message: string } | null = null;

export function ChatForm({ conversationId, selectionKey, isNewConversation = false }: { conversationId: string; selectionKey: string; isNewConversation?: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState(() => carriedDraft?.conversationId === conversationId ? carriedDraft.message : "");
  const currentDraft = useRef(message);
  useEffect(() => {
    if (!isNewConversation && carriedDraft?.conversationId === conversationId) carriedDraft = null;
  }, [conversationId, isNewConversation]);
  const [tools, setTools] = useState<string[]>([]);
  const { send, cancel, busy, error, status } = useChatRequest();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim() || busy) return;
    const result = await send({ conversationId, message });
    if (result) {
      if (isNewConversation && currentDraft.current !== message) carriedDraft = { conversationId, message: currentDraft.current };
      selectConversation(selectionKey, conversationId);
      setTools(result.toolsUsed ?? []);
      setMessage(current => current === message ? "" : current);
      router.push(`/ai?conversation=${conversationId}`);
      router.refresh();
    }
  }

  return <><AiToolActivity tools={tools} /><form onSubmit={submit} className="ai-composer mt-7"><label htmlFor="question" className="text-xs font-medium text-muted-foreground">Ask about your finances</label>
    <textarea id="question" value={message} onChange={event => { currentDraft.current = event.target.value; if (carriedDraft?.conversationId === conversationId) carriedDraft.message = event.target.value; setMessage(event.target.value); }} maxLength={4000} rows={3} className="mt-2 block w-full resize-y rounded p-2 text-sm" placeholder="What changed in my spending last month?" />
    {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
    {status === "canceled" && <p role="status" className="mt-2 text-sm">Canceled. Previously completed edits remain in transaction history.</p>}
    {busy && <button type="button" onClick={() => void cancel()} className="mt-3 mr-3 rounded-lg border px-4 py-2 text-sm">Stop</button>}
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><span role={busy ? "status" : undefined} className="font-mono text-[10px] text-muted-foreground">{busy ? "Request running · waiting for response" : "Code is displayed, never executed here"}</span><button disabled={busy || !message.trim()} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{busy ? "Thinking…" : "Send"}</button></div>
  </form></>;
}
