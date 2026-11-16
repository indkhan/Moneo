"use client";

import { useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, RotateCcw } from "lucide-react";
import type { ChatAttachment } from "@/lib/ai/chat-attachments";
import type { ChatItem } from "./chat-messages";

export const RESEND_EVENT = "moneo-chat-resend";
export type Resend = { message: string; attachments: ChatAttachment[]; spoken: boolean; regenerates: string };
export type AnswerVersion = { index: number; count: number; onChange: (index: number) => void };

export function resendQuestion(messages: ChatItem[], index: number): Resend | null {
  const regenerates = messages[index]?.answer_of;
  const question = messages.slice(0, index).findLast(item => item.role === "user");
  return regenerates && question ? { message: question.content, attachments: question.attachments ?? [], spoken: !!question.spoken, regenerates } : null;
}

export function answerGroups(messages: ChatItem[]): ChatItem[][] {
  const groups: ChatItem[][] = [];
  const byAnswer = new Map<string, ChatItem[]>();
  for (const item of messages) {
    const earlier = item.role === "assistant" && item.answer_of ? byAnswer.get(item.answer_of) : undefined;
    if (earlier) { groups.splice(groups.indexOf(earlier), 1); earlier.push(item); groups.push(earlier); continue; }
    const group = [item];
    groups.push(group);
    if (item.role === "assistant" && item.answer_of) byAnswer.set(item.answer_of, group);
  }
  return groups;
}

export function MessageActions({ content, model, resend, version }: { content: string; model?: string; resend: Resend | null; version?: AnswerVersion }) {
  const [copied, setCopied] = useState(false);
  const button = "flex size-11 items-center justify-center rounded-lg hover:bg-muted hover:text-foreground lg:size-8";
  return <div className="mt-2 flex items-center gap-0.5 text-muted-foreground">
    {version && version.count > 1 && <span className="mr-1 flex items-center">
      <button type="button" aria-label="Previous answer" disabled={version.index === 0} className={`${button} disabled:opacity-40`} onClick={() => version.onChange(version.index - 1)}><ChevronLeft className="size-4" aria-hidden="true" /></button>
      <span className="text-xs tabular-nums" aria-label={`Answer ${version.index + 1} of ${version.count}`}>{version.index + 1}/{version.count}</span>
      <button type="button" aria-label="Next answer" disabled={version.index === version.count - 1} className={`${button} disabled:opacity-40`} onClick={() => version.onChange(version.index + 1)}><ChevronRight className="size-4" aria-hidden="true" /></button>
    </span>}
    <button type="button" aria-label="Copy message" title="Copy" className={button} onClick={async () => {
      try { await navigator.clipboard.writeText(content); setCopied(true); } catch { setCopied(false); }
    }}>{copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}</button>
    {resend && <button type="button" aria-label="Regenerate reply" title="Regenerate" className={button} onClick={() => window.dispatchEvent(new CustomEvent(RESEND_EVENT, { detail: resend }))}><RotateCcw className="size-4" aria-hidden="true" /></button>}
    {model && <span className="ml-1.5 min-w-0 truncate text-xs"><span className="sr-only">Model: </span>{model}</span>}
  </div>;
}
