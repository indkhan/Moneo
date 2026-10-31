"use client";

import dynamic from "next/dynamic";
import { AiToolActivity, type ToolStep } from "./ai-tool-activity";
import type { HistoryMessage } from "@/lib/ai/conversation-history";
import type { FollowUp } from "@/lib/ai/follow-ups";
import Link from "next/link";
import { ChevronRight, FileText, ListChecks, LoaderCircle, Mic, Sparkle } from "lucide-react";
import type { ChatAttachment } from "@/lib/ai/chat-attachments";
import { VoiceCallCard } from "./voice-call-card";

export const DRAFT_EVENT = "moneo-chat-draft";
/** One-click next steps: prompts fill the composer (the user still sends), links navigate. */
function FollowUps({ items, compact }: { items: FollowUp[]; compact: boolean }) {
  if (!items.length) return null;
  const chip = `rounded-full border border-input text-muted-foreground hover:bg-muted hover:text-foreground ${compact ? "px-3 py-1 text-xs" : "px-3.5 py-2 text-[13px]"}`;
  return <div className="mt-3 flex flex-wrap gap-2" aria-label="Suggested next steps">{items.map(item => item.href
    ? <Link key={item.label} href={item.href} className={chip}>{item.label} →</Link>
    : <button key={item.label} type="button" className={chip} onClick={() => window.dispatchEvent(new CustomEvent(DRAFT_EVENT, { detail: { prompt: item.prompt, compact } }))}>{item.label}</button>)}</div>;
}
/** The plan stays open while answering; finished answers keep it collapsed. */
function Plan({ steps, done, collapsed = false }: { steps: string[]; done: boolean; collapsed?: boolean }) {
  return <details open={!collapsed || undefined} className="group my-2 rounded-xl border border-border p-3 text-sm">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">{done ? <ListChecks className="size-3.5" aria-hidden="true" /> : <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}Investigation plan<ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" /></summary>
    <ol className="mt-1 list-decimal space-y-0.5 pl-5">{steps.map(step => <li key={step}>{step}</li>)}</ol>
  </details>;
}

/** Photos show as thumbnails and PDFs as chips; both open the private file. */
function MessageFiles({ files }: { files?: ChatAttachment[] }) {
  if (!files?.length) return null;
  return <ul className="mb-2 ml-auto flex w-fit max-w-[85%] flex-wrap justify-end gap-2" aria-label="Attachments">{files.map(file => {
    const href = `/api/chat/attachments?${new URLSearchParams({ path: file.path })}`;
    return <li key={file.path}><a href={href} target="_blank" rel="noreferrer" title={file.name} className="block">
      {/* eslint-disable-next-line @next/next/no-img-element -- private, signed or local blob images cannot go through the image optimizer */}
      {file.type.startsWith("image/") ? <img src={href} alt={file.name} className="h-28 max-w-48 rounded-xl border border-border object-cover" />
        : <span className="flex max-w-56 items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm"><FileText className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">{file.name}</span></span>}
    </a></li>;
  })}</ul>;
}

// The markdown renderer is the heaviest client code here; split it out of the page bundle.
const AiMessage = dynamic(() => import("./ai-message").then(module => module.AiMessage), {
  loading: () => <div className="h-5 w-2/3 animate-pulse rounded bg-muted" aria-hidden="true" />,
});

export type ChatItem = Omit<HistoryMessage, "tools"> & { tools?: (string | ToolStep)[]; plan?: string[]; followUps?: FollowUp[] };
/** A run that kept going while the user was away: its question is already in the history, so only the working state shows. */
export const RESUMED_RUN: PendingExchange = { question: "", tools: [] };
export type PendingExchange = { question: string; spoken?: boolean; attachments?: ChatAttachment[]; tools: ToolStep[]; answer?: string; streaming?: boolean; plan?: string[]; steers?: string[] };

/** A small mic before a message that was spoken rather than typed. */
function Spoken({ show }: { show?: boolean }) {
  return show ? <><Mic className="mr-1.5 inline size-3.5 align-[-2px] text-muted-foreground" aria-hidden="true" /><span className="sr-only">Spoken: </span></> : null;
}

/** Message list shared by the AI page and the Ask Moneo panel. */
export function ChatMessages({ messages, pending, compact = false }: { messages: ChatItem[]; pending?: PendingExchange | null; compact?: boolean }) {
  const bubble = `ml-auto w-fit max-w-[85%] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[18px_18px_4px_18px] bg-input ${compact ? "px-3.5 py-2 text-sm" : "px-[18px] py-3.5 text-[15px]"}`;
  // The assistant speaks without a bubble, under a violet byline, as in the design.
  const assistant = (body: React.ReactNode) => <div className="min-w-0"><p className="mb-2 flex items-center gap-2 text-xs text-ai"><Sparkle className="size-3.5 fill-current" aria-hidden="true" />Moneo</p>{body}</div>;
  return <div className={`min-w-0 max-w-full ${compact ? "space-y-6" : "space-y-8"}`} aria-live="polite">
    {messages.map(item => <article key={item.id}>
      <time className="sr-only" dateTime={item.created_at}>{item.created_at}</time>
      {item.call ? <VoiceCallCard call={item.call} createdAt={item.created_at} /> : item.role === "user" ? <><MessageFiles files={item.attachments} /><p className={bubble}><Spoken show={item.spoken} />{item.content}</p></> : assistant(<>{item.plan && <Plan steps={item.plan} done collapsed />}<AiToolActivity tools={item.tools ?? []} /><AiMessage content={item.content} />{item === messages.at(-1) && !pending && <FollowUps items={item.followUps ?? []} compact={compact} />}</>)}
    </article>)}
    {pending && <article className={compact ? "space-y-6" : "space-y-8"}>
      {pending.question && <div><MessageFiles files={pending.attachments} /><p className={bubble}><Spoken show={pending.spoken} />{pending.question}</p></div>}
      {pending.steers?.map((steer, index) => <p key={index} className={bubble}>{steer}</p>)}
      {assistant(<>{pending.plan && <Plan steps={pending.plan} done={Boolean(pending.answer)} />}<AiToolActivity tools={pending.tools} />{pending.answer ? <><AiMessage content={pending.answer} />{!pending.streaming && <p role="status" className="mt-2 text-xs text-muted-foreground">Saving to history…</p>}</>
        : <p role="status" className="flex items-center gap-2 py-1 text-sm text-muted-foreground"><span className="flex gap-1" aria-hidden="true">{[0, 150, 300].map(delay => <span key={delay} className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-bounce" style={{ animationDelay: `${delay}ms` }} />)}</span>{!pending.tools.length ? "Thinking…" : pending.tools.some(tool => tool.state === "running") ? "Working with your data…" : "Writing the answer…"}</p>}</>)}
    </article>}
  </div>;
}

/** Applies one stream event to the pending exchange. */
export function applyChatEvent(pending: PendingExchange, event: { type: string; id?: string; name?: string; state?: ToolStep["state"]; input?: unknown; output?: string; answer?: string; text?: string; steps?: string[]; steers?: { id: string; content: string }[] }): PendingExchange {
  if (event.type === "delta" && event.text) return { ...pending, answer: (pending.answer ?? "") + event.text, streaming: true };
  if (event.type === "tool" && event.name && event.state) {
    const step: ToolStep = { id: event.id, name: event.name, state: event.state, ...(event.input !== undefined && { input: event.input }), ...(event.output !== undefined && { output: event.output }) };
    const index = pending.tools.findIndex(tool => event.id ? tool.id === event.id : tool.name === event.name && tool.state === "running");
    return { ...pending, tools: index < 0 ? [...pending.tools, step] : pending.tools.map((tool, i) => i === index ? { ...tool, ...step } : tool) };
  }
  if (event.type === "steered" && event.steers?.length) return { ...pending, steers: [...pending.steers ?? [], ...event.steers.map(steer => steer.content)] };
  if (event.type === "plan" && event.steps) return { ...pending, plan: event.steps };
  if (event.type === "answer" && event.answer) return { ...pending, answer: event.answer, streaming: false };
  return pending;
}
