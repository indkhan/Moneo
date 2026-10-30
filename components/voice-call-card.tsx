"use client";

import dynamic from "next/dynamic";
import { ChevronRight, LoaderCircle, Phone } from "lucide-react";
import { IouCard } from "@/components/iou-card";
import type { CallCard } from "@/lib/ai/voice-call-history";

const AiMessage = dynamic(() => import("./ai-message").then(module => module.AiMessage), {
  loading: () => <div className="h-5 w-2/3 animate-pulse rounded bg-muted" aria-hidden="true" />,
});

export function callDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min${seconds % 60 ? ` ${seconds % 60} s` : ""}` : `${seconds} s`;
}

const STATUS = { running: "still running", completed: "finished afterwards", failed: "failed", canceled: "stopped" } as const;
const fold = "group rounded-xl border border-border px-3 text-sm";
const foldTitle = "-mx-3 flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ai [&::-webkit-details-marker]:hidden";

/** A finished voice call in the chat: summary, cards, anything left running, the requests it made and the full transcript. */
export function VoiceCallCard({ call, createdAt }: { call: CallCard; createdAt: string }) {
  const bullets = call.summary?.split("\n").map(line => line.replace(/^-\s*/, "")).filter(Boolean) ?? [];
  return <section aria-label="Voice call" className="space-y-3 rounded-2xl border border-border bg-card p-4">
    <div className="flex items-center gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-full bg-ai-soft text-ai"><Phone className="size-4" aria-hidden="true" /></span>
      <p className="text-sm leading-tight"><span className="block font-medium">Voice call</span><span className="text-xs text-muted-foreground">{callDuration(call.durationSeconds)} · <time dateTime={createdAt} suppressHydrationWarning>{new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></span></p></div>
    {call.summaryStatus === "pending" && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />Writing the summary…</p>}
    {bullets.length > 0 && <ul aria-label="Call summary" className="list-disc space-y-1 pl-5 text-[15px]">{bullets.map(line => <li key={line}>{line}</li>)}</ul>}
    {call.cards.length > 0 && <div role="region" aria-label="Cards from this call"><p className="eyebrow">Cards from this call</p>{call.cards.map(id => <IouCard key={id} id={id} />)}</div>}
    {call.unfinished.length > 0 && <div><p className="eyebrow pb-1">Still running when the call ended</p>
      <ul className="space-y-1 text-sm">{call.unfinished.map((task, index) => <li key={index} className="flex items-center gap-2">
        {task.status === "running" ? <LoaderCircle className="size-3.5 shrink-0 text-ai motion-safe:animate-spin" aria-hidden="true" /> : <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${task.status === "completed" ? "bg-success" : task.status === "failed" ? "bg-danger" : "bg-subtle"}`} />}
        <span className="min-w-0">{task.text} <span className="text-muted-foreground">· {STATUS[task.status]}</span></span></li>)}</ul></div>}
    {call.exchanges.length > 0 && <details className={fold}><summary className={foldTitle}>Requests from this call ({call.exchanges.filter(item => item.role === "user").length})<ChevronRight className="ml-auto size-4 transition-transform group-open:rotate-90" aria-hidden="true" /></summary>
      <div className="space-y-4 pb-3">{call.exchanges.map(item => item.role === "user"
        ? <p key={item.id} className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl bg-input px-3.5 py-2">{item.content}</p>
        : <AiMessage key={item.id} content={item.content} />)}</div></details>}
    {call.transcript.length > 0 && <details className={fold}><summary className={foldTitle}>Full transcript<ChevronRight className="ml-auto size-4 transition-transform group-open:rotate-90" aria-hidden="true" /></summary>
      <ol aria-label="Transcript" className="space-y-2 pb-3">{call.transcript.map((turn, index) => <li key={index}><span className="font-medium">{turn.role === "user" ? "You" : "Moneo"}: </span>{turn.text}</li>)}</ol></details>}
  </section>;
}
