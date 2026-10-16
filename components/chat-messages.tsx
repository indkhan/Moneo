"use client";

import dynamic from "next/dynamic";
import { AiToolActivity, type ToolStep } from "./ai-tool-activity";
import type { HistoryMessage } from "@/lib/ai/conversation-history";

// The markdown renderer is the heaviest client code here; split it out of the page bundle.
const AiMessage = dynamic(() => import("./ai-message").then(module => module.AiMessage), {
  loading: () => <div className="h-5 w-2/3 animate-pulse rounded bg-muted" aria-hidden="true" />,
});

export type ChatItem = HistoryMessage & { tools?: string[] };
export type PendingExchange = { question: string; tools: ToolStep[]; answer?: string };

/** Message list shared by the AI page and the Ask Moneo panel. */
export function ChatMessages({ messages, pending, compact = false }: { messages: ChatItem[]; pending?: PendingExchange | null; compact?: boolean }) {
  const bubble = `ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-3xl bg-muted px-4 py-2.5 ${compact ? "text-sm" : "text-[15px]"}`;
  const avatar = <span className={`mt-0.5 flex shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground ${compact ? "size-6 text-[11px]" : "size-7 text-xs"}`} aria-hidden="true">M</span>;
  const assistant = (body: React.ReactNode) => <div className={`flex min-w-0 ${compact ? "gap-2.5" : "gap-3"}`}>{avatar}<div className="min-w-0 flex-1">{body}</div></div>;
  return <div className={compact ? "space-y-6" : "space-y-8"} aria-live="polite">
    {messages.map(item => <article key={item.id}>
      <time className="sr-only" dateTime={item.created_at}>{item.created_at}</time>
      {item.role === "user" ? <p className={bubble}>{item.content}</p> : assistant(<><AiToolActivity tools={item.tools ?? []} /><AiMessage content={item.content} /></>)}
    </article>)}
    {pending && <article className={compact ? "space-y-6" : "space-y-8"}>
      <p className={bubble}>{pending.question}</p>
      {assistant(<><AiToolActivity tools={pending.tools} />{pending.answer ? <><AiMessage content={pending.answer} /><p role="status" className="mt-2 text-xs text-muted-foreground">Saving to history…</p></>
        : <p role="status" className="flex items-center gap-2 py-1 text-sm text-muted-foreground"><span className="flex gap-1" aria-hidden="true">{[0, 150, 300].map(delay => <span key={delay} className="size-1.5 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: `${delay}ms` }} />)}</span>{pending.tools.length ? "Working with your data…" : "Thinking…"}</p>}</>)}
    </article>}
  </div>;
}

/** Applies one stream event to the pending exchange. */
export function applyChatEvent(pending: PendingExchange, event: { type: string; id?: string; name?: string; state?: ToolStep["state"]; answer?: string }): PendingExchange {
  if (event.type === "tool" && event.name && event.state) {
    const step = { id: event.id, name: event.name, state: event.state };
    const index = pending.tools.findIndex(tool => event.id ? tool.id === event.id : tool.name === event.name && tool.state === "running");
    return { ...pending, tools: index < 0 ? [...pending.tools, step] : pending.tools.map((tool, i) => i === index ? step : tool) };
  }
  if (event.type === "answer" && event.answer) return { ...pending, answer: event.answer };
  return pending;
}
