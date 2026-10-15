"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { selectConversation } from "@/lib/ai/selected-conversation";

import { useChatRequest } from "@/lib/ai/use-chat-request";
import { AiToolActivity } from "@/components/ai-tool-activity";
import { ArrowUp, Square } from "lucide-react";

const suggestions = ["What changed in my spending last month?", "Where did most of my money go this month?", "Find my largest transactions", "Create a spending chart"];

// First-send navigation remounts the composer under its saved conversation key.
// Carry only that pending draft in memory until the new composer mounts.
let carriedDraft: { conversationId: string; message: string } | null = null;

export function ChatForm({ conversationId, selectionKey, isNewConversation = false, empty = false, scope }: { conversationId: string; selectionKey: string; isNewConversation?: boolean; empty?: boolean; scope?: React.ReactNode }) {
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

  function draft(value: string) { currentDraft.current = value; if (carriedDraft?.conversationId === conversationId) carriedDraft.message = value; setMessage(value); }

  const composer = <form onSubmit={submit} className="rounded-3xl border border-border bg-card p-2 shadow-sm focus-within:border-muted-foreground/40">
    <label htmlFor="question" className="sr-only">Ask about your finances</label>
    <textarea id="question" value={message} onChange={event => draft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} maxLength={4000} rows={1} className="block max-h-60 min-h-12 w-full resize-none bg-transparent px-3 py-2.5 text-[15px] [field-sizing:content] focus:outline-none" placeholder="Ask anything about your money" />
    <div className="flex items-center justify-between gap-3 pl-3"><span role={busy ? "status" : undefined} className="text-xs text-muted-foreground">{busy ? "Waiting for a response…" : ""}</span>
      {busy ? <button type="button" onClick={() => void cancel()} aria-label="Stop" className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90"><Square className="size-3.5 fill-current" aria-hidden="true" /></button>
        : <button disabled={!message.trim()} aria-label="Send" className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30"><ArrowUp className="size-5" aria-hidden="true" /></button>}</div>
  </form>;
  const notices = <>{error && <p role="alert" className="mt-2 px-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    {status === "canceled" && <p role="status" className="mt-2 px-3 text-sm text-muted-foreground">Canceled. Previously completed edits remain in transaction history.</p>}</>;

  if (empty) return <div className="flex flex-1 flex-col justify-center py-10">
    <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">How can I help with your money today?</h2>
    <div className="mt-8">{composer}{notices}</div>
    <div className="mt-4 flex flex-wrap justify-center gap-2">{suggestions.map(prompt => <button key={prompt} type="button" onClick={() => { draft(prompt); document.getElementById("question")?.focus(); }} className="rounded-full border border-border px-3.5 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">{prompt}</button>)}</div>
    {scope}
  </div>;

  return <><AiToolActivity tools={tools} /><div className="sticky bottom-0 mt-auto bg-gradient-to-t from-background from-70% to-transparent pt-6 pb-4">{composer}{notices}{scope}</div></>;
}
