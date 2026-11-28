"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, RotateCcw } from "lucide-react";
import type { ChatAttachment } from "@/lib/ai/chat-attachments";
import type { PathStep } from "@/lib/ai/chat-tree";
import type { ChatItem } from "./chat-messages";

export const RESEND_EVENT = "moneo-chat-resend";
export type Resend = { message: string; attachments: ChatAttachment[]; spoken: boolean; after: string | null; regenerates?: string; edits?: string; model?: string };
export type Versions = { index: number; count: number; onChange: (index: number) => void };

export const regenerateOf = (step: PathStep, question: ChatItem): Resend =>
  ({ message: question.content, attachments: question.attachments ?? [], spoken: !!question.spoken, after: step.after, regenerates: step.question });
export const editOf = (step: PathStep, question: ChatItem, message: string): Resend =>
  ({ message, attachments: question.attachments ?? [], spoken: false, after: step.after, edits: step.question });
export const resend = (detail: Resend) => window.dispatchEvent(new CustomEvent(RESEND_EVENT, { detail }));

const button = "flex size-11 items-center justify-center rounded-lg hover:bg-muted hover:text-foreground lg:size-8";

export function VersionPicker({ versions, label }: { versions?: Versions; label: string }) {
  if (!versions || versions.count < 2) return null;
  const { index, count, onChange } = versions;
  return <span className="flex items-center">
    <button type="button" aria-label={`Previous ${label}`} disabled={index === 0} className={`${button} disabled:opacity-40`} onClick={() => onChange(index - 1)}><ChevronLeft className="size-4" aria-hidden="true" /></button>
    <span className="text-xs tabular-nums" aria-label={`${label[0]?.toUpperCase()}${label.slice(1)} ${index + 1} of ${count}`}>{index + 1}/{count}</span>
    <button type="button" aria-label={`Next ${label}`} disabled={index === count - 1} className={`${button} disabled:opacity-40`} onClick={() => onChange(index + 1)}><ChevronRight className="size-4" aria-hidden="true" /></button>
  </span>;
}

export function RegenerateButtons({ regenerate, models, label, className = button }: { regenerate: Resend; models: string[]; label: string; className?: string }) {
  return <>
    <button type="button" aria-label={label} title={label} className={className} onClick={() => resend(regenerate)}><RotateCcw className="size-4" aria-hidden="true" /></button>
    {models.length > 0 && <details className="relative">
      <summary aria-label={`${label} with another model`} title={`${label} with another model`} className={`${className} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}><ChevronDown className="size-4" aria-hidden="true" /></summary>
      <div className="absolute bottom-full right-0 z-20 mb-1 w-56 rounded-xl border border-border bg-card p-1 shadow-lg sm:left-0 sm:right-auto">
        <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{label} with</p>
        {models.map(option => <button key={option} type="button" className="block w-full truncate rounded-lg px-2.5 py-2 text-left text-sm text-foreground hover:bg-muted"
          onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); resend({ ...regenerate, model: option }); }}>{option}</button>)}
      </div>
    </details>}
  </>;
}

export function MessageActions({ content, model, regenerate, models = [], versions }: { content: string; model?: string; regenerate: Resend | null; models?: string[]; versions?: Versions }) {
  const [copied, setCopied] = useState(false);
  return <div className="mt-2 flex items-center gap-0.5 text-muted-foreground">
    <span className="mr-1"><VersionPicker versions={versions} label="answer" /></span>
    <button type="button" aria-label="Copy message" title="Copy" className={button} onClick={async () => {
      try { await navigator.clipboard.writeText(content); setCopied(true); } catch { setCopied(false); }
    }}>{copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}</button>
    {regenerate && <RegenerateButtons regenerate={regenerate} models={models} label="Regenerate" />}
    {model && <span className="ml-1.5 min-w-0 truncate text-xs"><span className="sr-only">Model: </span>{model}</span>}
  </div>;
}
