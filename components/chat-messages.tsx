"use client";

import dynamic from "next/dynamic";
import { AiToolActivity, type ToolStep } from "./ai-tool-activity";
import type { HistoryMessage } from "@/lib/ai/conversation-history";
import type { FollowUp } from "@/lib/ai/follow-ups";
import Link from "next/link";
import { ChevronRight, ListChecks, LoaderCircle } from "lucide-react";

export const DRAFT_EVENT = "moneo-chat-draft";
/** One-click next steps: prompts fill the composer (the user still sends), links navigate. */
function FollowUps({ items, compact }: { items: FollowUp[]; compact: boolean }) {
  if (!items.length) return null;
  const chip = "rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground";
  return <div className="mt-3 flex flex-wrap gap-2" aria-label="Suggested next steps">{items.map(item => item.href
    ? <Link key={item.label} href={item.href} className={chip}>{item.label} →</Link>
    : <button key={item.label} type="button" className={chip} onClick={() => window.dispatchEvent(new CustomEvent(DRAFT_EVENT, { detail: { prompt: item.prompt, compact } }))}>{item.label}</button>)}</div>;
}
/** The plan stays open while answering; finished answers keep it collapsed. */
function Plan({ steps, done, collapsed = false }: { steps: string[]; done: boolean; collapsed?: boolean }) {
  return <details open={!collapsed || undefined} className="group my-2 rounded-lg border border-border p-3 text-sm">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">{done ? <ListChecks className="size-3.5" aria-hidden="true" /> : <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}Investigation plan<ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" /></summary>
    <ol className="mt-1 list-decimal space-y-0.5 pl-5">{steps.map(step => <li key={step}>{step}</li>)}</ol>
  </details>;
}

// The markdown renderer is the heaviest client code here; split it out of the page bundle.
const AiMessage = dynamic(() => import("./ai-message").then(module => module.AiMessage), {
  loading: () => <div className="h-5 w-2/3 animate-pulse rounded bg-muted" aria-hidden="true" />,
});

export type ChatItem = HistoryMessage & { tools?: (string | ToolStep)[]; plan?: string[]; followUps?: FollowUp[] };
export type PendingExchange = { question: string; tools: ToolStep[]; answer?: string; plan?: string[]; steers?: string[] };

/** Message list shared by the AI page and the Ask Moneo panel. */
export function ChatMessages({ messages, pending, compact = false }: { messages: ChatItem[]; pending?: PendingExchange | null; compact?: boolean }) {
  const bubble = `ml-auto w-fit max-w-[85%] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-3xl bg-muted px-4 py-2.5 ${compact ? "text-sm" : "text-[15px]"}`;
  const avatar = <span className={`mt-0.5 flex shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground ${compact ? "size-6 text-[11px]" : "size-7 text-xs"}`} aria-hidden="true">M</span>;
  const assistant = (body: React.ReactNode) => <div className={`flex min-w-0 ${compact ? "gap-2.5" : "gap-3"}`}>{avatar}<div className="min-w-0 flex-1">{body}</div></div>;
  return <div className={`min-w-0 max-w-full ${compact ? "space-y-6" : "space-y-8"}`} aria-live="polite">
    {messages.map(item => <article key={item.id}>
      <time className="sr-only" dateTime={item.created_at}>{item.created_at}</time>
      {item.role === "user" ? <p className={bubble}>{item.content}</p> : assistant(<>{item.plan && <Plan steps={item.plan} done collapsed />}<AiToolActivity tools={item.tools ?? []} /><AiMessage content={item.content} />{item === messages.at(-1) && !pending && <FollowUps items={item.followUps ?? []} compact={compact} />}</>)}
    </article>)}
    {pending && <article className={compact ? "space-y-6" : "space-y-8"}>
      <p className={bubble}>{pending.question}</p>
      {pending.steers?.map((steer, index) => <p key={index} className={bubble}>{steer}</p>)}
      {assistant(<>{pending.plan && <Plan steps={pending.plan} done={Boolean(pending.answer)} />}<AiToolActivity tools={pending.tools} />{pending.answer ? <><AiMessage content={pending.answer} /><p role="status" className="mt-2 text-xs text-muted-foreground">Saving to history…</p></>
        : <p role="status" className="flex items-center gap-2 py-1 text-sm text-muted-foreground"><span className="flex gap-1" aria-hidden="true">{[0, 150, 300].map(delay => <span key={delay} className="size-1.5 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: `${delay}ms` }} />)}</span>{pending.tools.length ? "Working with your data…" : "Thinking…"}</p>}</>)}
    </article>}
  </div>;
}

/** Applies one stream event to the pending exchange. */
export function applyChatEvent(pending: PendingExchange, event: { type: string; id?: string; name?: string; state?: ToolStep["state"]; input?: unknown; output?: string; answer?: string; steps?: string[]; steers?: { id: string; content: string }[] }): PendingExchange {
  if (event.type === "tool" && event.name && event.state) {
    const step: ToolStep = { id: event.id, name: event.name, state: event.state, ...(event.input !== undefined && { input: event.input }), ...(event.output !== undefined && { output: event.output }) };
    const index = pending.tools.findIndex(tool => event.id ? tool.id === event.id : tool.name === event.name && tool.state === "running");
    return { ...pending, tools: index < 0 ? [...pending.tools, step] : pending.tools.map((tool, i) => i === index ? { ...tool, ...step } : tool) };
  }
  if (event.type === "steered" && event.steers?.length) return { ...pending, steers: [...pending.steers ?? [], ...event.steers.map(steer => steer.content)] };
  if (event.type === "plan" && event.steps) return { ...pending, plan: event.steps };
  if (event.type === "answer" && event.answer) return { ...pending, answer: event.answer };
  return pending;
}
