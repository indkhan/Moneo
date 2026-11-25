"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { selectConversation } from "@/lib/ai/selected-conversation";
import { useChatRequest, type ChatAnswer, type ChatStreamEvent } from "@/lib/ai/use-chat-request";
import { useChatQueue } from "@/lib/ai/use-chat-queue";
import { useChatAttachments } from "@/lib/ai/use-chat-attachments";
import { ATTACHMENT_ONLY_MESSAGE, type ChatAttachment } from "@/lib/ai/chat-attachments";
import { ChatComposer, withSpoken } from "@/components/chat-composer";
import { VOICE_CONTEXT } from "@/lib/ai/voice-context";
import { ChatQueue } from "@/components/chat-queue";
import { DRAFT_EVENT } from "@/components/chat-messages";
import { RESEND_EVENT, type Resend } from "@/components/message-actions";
import { useAiAccess } from "@/lib/ai/use-ai-access";

const draftIsNotKeptWhenStorageIsBlocked = () => undefined;
const suggestions = ["What changed in my spending last month?", "Where did most of my money go this month?", "Find my largest transactions", "Create a spending chart"];

export type ChatFormEvents = {
  onStart?: (conversationId: string, question: string, attachments: ChatAttachment[], spoken: boolean, after?: string | null) => void;
  onEvent?: (conversationId: string, event: ChatStreamEvent) => void;
  onDone?: (conversationId: string, question: string, result: (ChatAnswer & { requestId: string }) | null, attachments: ChatAttachment[]) => void;
};

function ModelSelect({ conversationId, saved, persisted, value, onChange }: { conversationId: string; saved: boolean; persisted: boolean; value: string; onChange: (model: string) => void }) {
  const access = useAiAccess();
  const [problem, setProblem] = useState("");
  if (!access?.models.length && !value) return null;
  async function choose(next: string) {
    onChange(next); setProblem("");
    if (!persisted) return;
    const response = await fetch(`/api/conversations/${conversationId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: next || null }) }).catch(() => null);
    if (!response?.ok) setProblem("Could not save the model for this chat. Try again.");
  }
  const options = [...new Set([...access?.models ?? [], ...value ? [value] : []])];
  return <label className="flex min-w-0 items-center" title={problem || (saved ? "Model for this chat" : "Model for this chat; the default comes from Settings")}>
    <span className="sr-only">Model for this chat</span>
    <select value={value} onChange={event => void choose(event.target.value)} aria-invalid={!!problem || undefined}
      className={`h-8 max-w-40 min-w-0 truncate rounded-lg bg-transparent px-1.5 text-xs hover:bg-muted hover:text-foreground focus:outline-none sm:max-w-56 ${problem ? "text-danger" : "text-muted-foreground"}`}>
      <option value="">{access?.chatModel ? `Default · ${access.chatModel}` : "Default model"}</option>
      {options.map(option => <option key={option} value={option}>{option}</option>)}
    </select>
    {problem && <span role="alert" className="sr-only">{problem}</span>}
  </label>;
}

export function ChatForm({ conversationId, selectionKey, empty = false, scope, placeholder = "Ask anything about your money", autoSend, parent, model, persisted = false, onStart, onEvent, onDone }: { conversationId: string; selectionKey: string; isNewConversation?: boolean; empty?: boolean; scope?: React.ReactNode; placeholder?: string; autoSend?: string; parent?: string | null; model?: string | null; persisted?: boolean } & ChatFormEvents) {
  const [message, setMessage] = useState("");
  const [chosen, setChosen] = useState(model ?? "");
  const draftKey = `moneo-chat-draft:${conversationId}`;
  const draftLoaded = useRef(false);
  useEffect(() => {
    try {
      if (draftLoaded.current) { if (message) sessionStorage.setItem(draftKey, message); else sessionStorage.removeItem(draftKey); return; }
      draftLoaded.current = true;
      const saved = sessionStorage.getItem(draftKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setMessage(current => current || saved);
    } catch { draftIsNotKeptWhenStorageIsBlocked(); }
  }, [message, draftKey]);
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
    if (busy) { if (files.items.length) return; enqueue(message); setMessage(""); return; }
    void sendMessage(message, false, files.ready);
  }

  function sendSpoken(text: string) {
    const typed = withSpoken(message, text);
    if (files.uploading || files.items.some(item => item.error) || (busy && files.items.length)) { setMessage(typed); document.getElementById("question")?.focus(); return; }
    if (busy) { enqueue(typed); setMessage(""); return; }
    void sendMessage(typed, false, files.ready, true);
  }

  async function sendMessage(typed: string, queued = false, attachments: ChatAttachment[] = [], spoken = false, branch?: Resend) {
    if (busy) return;
    const message = typed.trim() || ATTACHMENT_ONLY_MESSAGE;
    const requestModel = branch?.model ?? chosen;
    onStart?.(conversationId, message, attachments, spoken, branch?.after);
    if (!queued) { setMessage(""); files.clear(); }
    const result = await send({ conversationId, message, ...(branch?.regenerates && { regenerates: branch.regenerates }), ...(branch?.edits && { edits: branch.edits }),
      ...(!branch && !queued && parent && { parent }), ...(requestModel && { model: requestModel }),
      ...(spoken && { context: VOICE_CONTEXT }), ...(attachments.length && { attachments }) }, streamed => onEvent?.(conversationId, withSteers(streamed)));
    if (result) {
      selectConversation(selectionKey, conversationId);
    } else if (!queued) { setMessage(current => current || typed); files.restore(attachments); }
    onDone?.(conversationId, message, result, attachments);
  }

  function startQueued(next: string) {
    if (busy) return false;
    void sendMessage(next, true);
    return true;
  }
  const { queue, enqueue, remove, steer, withSteers, canSteer } = useChatQueue(chat, conversationId, startQueued);

  const autoSent = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!autoSend) { autoSent.current = undefined; return; }
    if (autoSent.current === autoSend) return;
    autoSent.current = autoSend;
    void sendMessage(autoSend);
  });
  useEffect(() => {
    const resend = (event: Event) => { const detail = (event as CustomEvent<Resend>).detail; void sendMessage(detail.message, true, detail.attachments, detail.spoken, detail); };
    window.addEventListener(RESEND_EVENT, resend);
    return () => window.removeEventListener(RESEND_EVENT, resend);
  });

  const composer = <><ChatQueue items={queue} canSteer={canSteer} onSteer={item => void steer(item)} onRemove={remove} /><ChatComposer id="question" label="Ask about your finances" value={message} onChange={setMessage} onSubmit={submit} onStop={() => void cancel()} busy={busy} placeholder={placeholder} busyText="Working on a reply. Anything you send now is queued." attachments={files} voice={{ onSend: sendSpoken }}
    tools={<ModelSelect conversationId={conversationId} saved={!!model} persisted={persisted} value={chosen} onChange={setChosen} />} /></>;
  const notices = <>{error && <p role="alert" className="mt-2 px-3 text-sm text-danger">{error}</p>}
    {status === "canceled" && <p role="status" className="mt-2 px-3 text-sm text-muted-foreground">Canceled. Previously completed edits remain in transaction history.</p>}</>;

  if (empty) return <div className="flex flex-1 flex-col justify-center py-10 max-lg:pt-6 max-lg:pb-0">
    <h2 className="text-center font-display text-3xl font-semibold tracking-tight max-lg:mt-auto max-lg:text-2xl sm:text-4xl">How can I help with your money today?</h2>
    <div className="sticky bottom-0 z-10 mt-8 bg-background lg:top-0 max-lg:order-last max-lg:mt-6 max-lg:pt-2 max-lg:pb-[calc(0.5rem+env(safe-area-inset-bottom))]">{composer}{notices}</div>
    <div className="mt-4 flex flex-wrap justify-center gap-2 max-lg:mt-6">{suggestions.map(prompt => <button key={prompt} type="button" onClick={() => { setMessage(prompt); document.getElementById("question")?.focus(); }} className="rounded-full border border-border px-3.5 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted">{prompt}</button>)}</div>
    <p className="mx-auto mt-6 max-w-xl text-center text-xs text-muted-foreground">Ask here for a quick answer. Run a deep review for a saved, evidence-checked report. Call to talk it through. Each one uses AI, tracked under <Link href="/settings" className="underline">Settings</Link>.</p>
    <div className="max-lg:mb-auto">{scope}</div>
  </div>;

  return <div className="sticky bottom-0 mt-auto bg-gradient-to-t from-background from-70% to-transparent pt-6 pb-4 max-lg:pb-[calc(0.5rem+env(safe-area-inset-bottom))]">{composer}{notices}{scope}</div>;
}
