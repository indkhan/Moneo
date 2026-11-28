"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { answerPick, questionPick, type ChatNode, type PathStep } from "@/lib/ai/chat-tree";
import type { ChatAnswer } from "@/lib/ai/use-chat-request";
import { AiToolActivity, type ToolStep } from "./ai-tool-activity";
import type { HistoryMessage } from "@/lib/ai/conversation-history";
import type { FollowUp } from "@/lib/ai/follow-ups";
import Link from "next/link";
import { ChevronRight, FileText, ListChecks, LoaderCircle, Mic, Pencil, Sparkle } from "lucide-react";
import type { ChatAttachment } from "@/lib/ai/chat-attachments";
import { VoiceCallCard } from "./voice-call-card";
import { MessageActions, VersionPicker, editOf, regenerateOf, resend, type Resend, type Versions } from "./message-actions";

export const DRAFT_EVENT = "moneo-chat-draft";
function FollowUps({ items, compact }: { items: FollowUp[]; compact: boolean }) {
  if (!items.length) return null;
  const chip = `rounded-full border border-input text-muted-foreground hover:bg-muted hover:text-foreground ${compact ? "px-3 py-1 text-xs" : "px-3.5 py-2 text-[13px]"}`;
  return <div className="mt-3 flex flex-wrap gap-2" aria-label="Suggested next steps">{items.map(item => item.href
    ? <Link key={item.label} href={item.href} className={chip}>{item.label} →</Link>
    : <button key={item.label} type="button" className={chip} onClick={() => window.dispatchEvent(new CustomEvent(DRAFT_EVENT, { detail: { prompt: item.prompt, compact } }))}>{item.label}</button>)}</div>;
}
function Plan({ steps, done, collapsed = false }: { steps: string[]; done: boolean; collapsed?: boolean }) {
  return <details open={!collapsed || undefined} className="group my-2 rounded-xl border border-border p-3 text-sm">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">{done ? <ListChecks className="size-3.5" aria-hidden="true" /> : <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}Investigation plan<ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" /></summary>
    <ol className="mt-1 list-decimal space-y-0.5 pl-5">{steps.map(step => <li key={step}>{step}</li>)}</ol>
  </details>;
}

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

const AiMessage = dynamic(() => import("./ai-message").then(module => module.AiMessage), {
  loading: () => <div className="h-5 w-2/3 animate-pulse rounded bg-muted" aria-hidden="true" />,
});

export type ChatItem = Omit<HistoryMessage, "tools"> & { tools?: (string | ToolStep)[]; plan?: string[]; followUps?: FollowUp[] };
export const RESUMED_RUN: PendingExchange = { question: "", tools: [] };
export type PendingExchange = { question: string; spoken?: boolean; attachments?: ChatAttachment[]; tools: ToolStep[]; answer?: string; streaming?: boolean; plan?: string[]; steers?: string[]; after?: string | null };

export function localExchange(question: string, result: ChatAnswer & { requestId: string }, finished: PendingExchange | undefined, attachments: ChatAttachment[]): { messages: ChatItem[]; node: ChatNode } {
  const now = new Date().toISOString();
  const request = result.requestId;
  return {
    node: { id: request, parent: result.parent ?? null, regenerates: result.regenerates ?? null, created_at: now },
    messages: [
      ...(result.regenerates ? [] : [{ id: `local-${crypto.randomUUID()}`, role: "user" as const, content: question.trim(), created_at: now, attachments, spoken: finished?.spoken, request }]),
      ...(finished?.steers ?? []).map(content => ({ id: `local-${crypto.randomUUID()}`, role: "user" as const, content, created_at: now, request, steer: true })),
      { id: `local-${crypto.randomUUID()}`, role: "assistant", content: result.answer, created_at: now, request, answer_of: result.regenerates ?? request, tools: finished?.tools.length ? finished.tools : result.toolsUsed, plan: finished?.plan, followUps: result.followUps, model: result.model },
    ],
  };
}

function QuestionEditor({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return <form className="ml-auto w-full max-w-[85%] space-y-2" onSubmit={event => { event.preventDefault(); if (text.trim()) onSave(text.trim()); }}>
    <label className="sr-only" htmlFor="edit-question">Edit your message</label>
    <textarea id="edit-question" autoFocus value={text} maxLength={4000} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Escape") onCancel(); }}
      className="block max-h-60 min-h-20 w-full resize-none rounded-2xl border border-border bg-input px-4 py-3 text-[15px] [field-sizing:content] focus:outline-none" />
    <span className="flex justify-end gap-2">
      <button type="button" onClick={onCancel} className="min-h-10 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">Cancel</button>
      <button disabled={!text.trim()} className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40">Send</button>
    </span>
  </form>;
}

function Spoken({ show }: { show?: boolean }) {
  return show ? <><Mic className="mr-1.5 inline size-3.5 align-[-2px] text-muted-foreground" aria-hidden="true" /><span className="sr-only">Spoken: </span></> : null;
}

export function ChatMessages({ messages, path = [], onPick, editable = false, models, pending, compact = false, toolResult }: { messages: ChatItem[]; path?: PathStep[]; onPick?: (key: string, id: string) => void; editable?: boolean; models?: string[]; pending?: PendingExchange | null; compact?: boolean; toolResult?: (step: ToolStep, key: number, regenerate: Resend | null) => React.ReactNode }) {
  const bubble = `ml-auto w-fit max-w-[85%] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[18px_18px_4px_18px] bg-input ${compact ? "px-3.5 py-2 text-sm" : "px-[18px] py-3.5 text-[15px]"}`;
  const files = useMemo(() => [...messages.flatMap(item => item.attachments ?? []), ...(pending?.attachments ?? [])], [messages, pending?.attachments]);
  const [editing, setEditing] = useState<string | null>(null);
  const results = (tools: (string | ToolStep)[], regenerate: Resend | null = null) => toolResult && tools.map((step, index) => typeof step === "string" ? null : toolResult(step, index, regenerate));
  const assistant = (body: React.ReactNode) => <div className="min-w-0"><p className="mb-2 flex items-center gap-2 text-xs text-ai"><Sparkle className="size-3.5 fill-current" aria-hidden="true" />Moneo</p>{body}</div>;
  const time = (at: string) => <time className="sr-only" dateTime={at} suppressHydrationWarning>{new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>;
  const answer = (item: ChatItem, actions: { regenerate?: Resend | null; versions?: Versions; last?: boolean } = {}) => assistant(<>{item.plan && <Plan steps={item.plan} done collapsed />}<AiToolActivity tools={item.tools ?? []} />{results(item.tools ?? [], actions.regenerate ?? null)}<AiMessage content={item.content} files={files} />
    <MessageActions content={item.content} model={item.model} regenerate={actions.regenerate ?? null} models={models} versions={actions.versions} />{actions.last && !pending && <FollowUps items={item.followUps ?? []} compact={compact} />}</>);
  const userBubble = (item: ChatItem) => <><MessageFiles files={item.attachments} /><p className={bubble}><Spoken show={item.spoken} />{item.content}</p></>;
  const shownUntil = pending?.after === undefined ? path.length : pending.after === null ? 0 : path.findIndex(step => step.answer === pending.after) + 1 || path.length;
  const shown = path.slice(0, shownUntil);
  const onPath = new Set(shown.flatMap(step => [step.question, step.answer]));
  const calls = messages.filter(item => item.call && item.requests?.some(id => onPath.has(id)));
  const canChange = editable && !pending;
  const blocks: { key: string; at: string; body: React.ReactNode }[] = [
    ...messages.filter(item => item.call ? !item.requests?.length : !item.request).map(item => ({ key: item.id, at: item.created_at,
      body: <>{time(item.created_at)}{item.call ? <VoiceCallCard call={item.call} createdAt={item.created_at} /> : item.role === "user" ? userBubble(item) : answer(item, { last: item === messages.at(-1) })}</> })),
    ...calls.map(item => ({ key: item.id, at: item.created_at, body: item.call && <VoiceCallCard call={item.call} createdAt={item.created_at} /> })),
    ...shown.flatMap((step, position) => {
      if (calls.some(call => call.requests?.includes(step.answer))) return [];
      const question = messages.find(item => item.role === "user" && !item.steer && !item.call && item.request === step.question);
      const reply = messages.find(item => item.role === "assistant" && !item.call && item.request === step.answer);
      if (!question && !reply) return [];
      const steers = messages.filter(item => item.steer && item.request === step.answer);
      const questionVersions = step.questions.length > 1 ? { index: step.questions.indexOf(step.question), count: step.questions.length, onChange: (next: number) => onPick?.(questionPick(step), step.questions[next]) } : undefined;
      const answerVersions = { index: step.answers.indexOf(step.answer), count: step.answers.length, onChange: (next: number) => onPick?.(answerPick(step), step.answers[next]) };
      return [{ key: step.answer, at: question?.created_at ?? reply?.created_at ?? "", body: <div className={compact ? "space-y-6" : "space-y-8"}>
        {question && (editing === step.question ? <QuestionEditor initial={question.content} onCancel={() => setEditing(null)} onSave={text => { setEditing(null); resend(editOf(step, question, text)); }} />
          : <div className="group">{time(question.created_at)}{userBubble(question)}
            {(questionVersions || canChange) && <div className="mt-1 flex items-center justify-end text-muted-foreground">
              <VersionPicker label="question" versions={questionVersions} />
              {canChange && <button type="button" aria-label="Edit message" title="Edit" onClick={() => setEditing(step.question)} className="flex size-11 items-center justify-center rounded-lg hover:bg-muted hover:text-foreground lg:size-8 lg:opacity-0 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100"><Pencil className="size-4" aria-hidden="true" /></button>}
            </div>}
          </div>)}
        {steers.map(steer => <p key={steer.id} className={bubble}>{steer.content}</p>)}
        {reply && answer(reply, { regenerate: canChange && question ? regenerateOf(step, question) : null, last: position === shown.length - 1, versions: answerVersions })}
      </div> }];
    }),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return <div className={`min-w-0 max-w-full ${compact ? "space-y-6" : "space-y-8"}`} aria-live="polite">
    {blocks.map(block => <article key={block.key}>{block.body}</article>)}
    {pending && <article className={compact ? "space-y-6" : "space-y-8"}>
      {pending.question && <div><MessageFiles files={pending.attachments} /><p className={bubble}><Spoken show={pending.spoken} />{pending.question}</p></div>}
      {pending.steers?.map((steer, index) => <p key={index} className={bubble}>{steer}</p>)}
      {assistant(<>{pending.plan && <Plan steps={pending.plan} done={Boolean(pending.answer)} />}<AiToolActivity tools={pending.tools} />{results(pending.tools)}{pending.answer ? <><AiMessage content={pending.answer} streaming={pending.streaming} files={files} />{!pending.streaming && <p role="status" className="mt-2 text-xs text-muted-foreground">Saving to history…</p>}</>
        : <p role="status" className="flex items-center gap-2 py-1 text-sm text-muted-foreground"><span className="flex gap-1" aria-hidden="true">{[0, 150, 300].map(delay => <span key={delay} className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-bounce" style={{ animationDelay: `${delay}ms` }} />)}</span>{!pending.tools.length ? "Thinking…" : pending.tools.some(tool => tool.state === "running") ? "Working with your data…" : "Writing the answer…"}</p>}</>)}
    </article>}
  </div>;
}

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
