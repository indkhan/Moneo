"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { selectConversation } from "@/lib/ai/selected-conversation";

import { useChatRequest } from "@/lib/ai/use-chat-request";
import { AiToolActivity } from "@/components/ai-tool-activity";
import { ChatContextControls, useChatContext } from "@/components/chat-context";

export function ChatForm({ conversationId, selectionKey, contextConversationId = conversationId }: { conversationId: string; selectionKey: string; contextConversationId?: string }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const { send, cancel, busy, error, status } = useChatRequest();
  const context = useChatContext(selectionKey, contextConversationId);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim() || busy) return;
    context.bindConversation(conversationId);
    const result = await send({ conversationId, message, context: context.context });
    if (result) {
      selectConversation(selectionKey, conversationId);
      setTools(result.toolsUsed ?? []);
      setMessage("");
      router.push(`/ai?conversation=${conversationId}`);
      router.refresh();
    }
  }

  return <><AiToolActivity tools={tools} /><form onSubmit={submit} className="ai-composer mt-7"><ChatContextControls state={context} disabled={busy} /><label htmlFor="question" className="text-xs font-medium text-muted-foreground">Ask about your finances</label>
    <textarea id="question" value={message} onChange={event => setMessage(event.target.value)} maxLength={4000} rows={3} className="mt-2 block w-full resize-y rounded p-2 text-sm" placeholder="What changed in my spending last month?" />
    {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
    {status === "canceled" && <p role="status" className="mt-2 text-sm">Canceled. Previously completed edits remain in transaction history.</p>}
    {busy && <button type="button" onClick={() => void cancel()} className="mt-3 mr-3 rounded-lg border px-4 py-2 text-sm">Stop</button>}
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><span role={busy ? "status" : undefined} className="font-mono text-[10px] text-muted-foreground">{busy ? "Request running · waiting for response" : "Code is displayed, never executed here"}</span><button disabled={busy || !message.trim()} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{busy ? "Thinking…" : "Send"}</button></div>
  </form></>;
}
