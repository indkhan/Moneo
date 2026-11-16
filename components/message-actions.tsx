"use client";

import { useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import type { ChatAttachment } from "@/lib/ai/chat-attachments";
import type { ChatItem } from "./chat-messages";

export const RESEND_EVENT = "moneo-chat-resend";
export type Resend = { message: string; attachments: ChatAttachment[] };

export function resendQuestion(messages: ChatItem[], index: number): Resend | null {
  const question = messages.slice(0, index).findLast(item => item.role === "user");
  return question ? { message: question.content, attachments: question.attachments ?? [] } : null;
}

export function MessageActions({ content, model, resend }: { content: string; model?: string; resend: Resend | null }) {
  const [copied, setCopied] = useState(false);
  const button = "flex size-11 items-center justify-center rounded-lg hover:bg-muted hover:text-foreground lg:size-8";
  return <div className="mt-2 flex items-center gap-0.5 text-muted-foreground">
    <button type="button" aria-label="Copy message" title="Copy" className={button} onClick={async () => {
      try { await navigator.clipboard.writeText(content); setCopied(true); } catch { setCopied(false); }
    }}>{copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}</button>
    {resend && <button type="button" aria-label="Regenerate reply" title="Regenerate" className={button} onClick={() => window.dispatchEvent(new CustomEvent(RESEND_EVENT, { detail: resend }))}><RotateCcw className="size-4" aria-hidden="true" /></button>}
    {model && <span className="ml-1.5 min-w-0 truncate text-xs"><span className="sr-only">Model: </span>{model}</span>}
  </div>;
}
