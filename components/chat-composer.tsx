import { ArrowUp, FileText, LoaderCircle, Paperclip, Square, X } from "lucide-react";
import type { ChatAttachments } from "@/lib/ai/use-chat-attachments";
import { VoiceInput } from "./voice-input";

/** Spoken words added after whatever is already typed. */
export const withSpoken = (typed: string, spoken: string) => [typed.trim(), spoken].filter(Boolean).join(" ");

/**
 * Composer shared by the AI page and the Ask Moneo panel. Enter sends (or queues while busy), Shift+Enter adds a line.
 * With `voice`, a mic sends spoken words through `voice.onSend` or drops them into the box to edit.
 */
export function ChatComposer({ id, label, value, onChange, onSubmit, onStop, busy, disabled = false, placeholder, compact = false, busyText, attachments, voice }: {
  id: string; label: string; value: string; onChange: (value: string) => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onStop: () => void; busy: boolean; disabled?: boolean; placeholder: string; compact?: boolean; busyText: string; attachments?: ChatAttachments;
  voice?: { onSend: (text: string) => void };
}) {
  const button = `flex items-center justify-center rounded-xl bg-primary text-primary-foreground hover:opacity-90 ${compact ? "size-9" : "size-11"}`;
  const files = attachments?.items ?? [];
  // A message can be just a photo or PDF; files still uploading or failed hold the send.
  const sendable = (value.trim() || attachments?.ready.length) && !attachments?.uploading && !files.some(item => item.error);
  return <form onSubmit={onSubmit} onPaste={event => { if (attachments && event.clipboardData.files.length) { event.preventDefault(); attachments.add(event.clipboardData.files); } }}
    className="relative rounded-2xl border border-input bg-card p-2.5 transition-colors focus-within:border-muted-foreground/60">
    {files.length > 0 && <ul className="flex flex-wrap gap-2 px-1 pb-2" aria-label="Attachments">{files.map(item => <li key={item.id} className={`flex max-w-56 items-center gap-2 rounded-lg border p-1.5 pr-1 text-xs ${item.error ? "border-danger text-danger" : "border-border"}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- private, signed or local blob images cannot go through the image optimizer */}
      {item.preview ? <img src={item.preview} alt="" className="size-8 shrink-0 rounded object-cover" /> : <FileText className="size-5 shrink-0" aria-hidden="true" />}
      <span className="min-w-0 truncate" title={item.error ?? item.name}>{item.error ?? item.name}</span>
      {!item.file && !item.error && <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-label="Uploading" />}
      <button type="button" onClick={() => attachments!.remove(item.id)} aria-label={`Remove ${item.name}`} className="rounded p-0.5 text-muted-foreground hover:text-foreground"><X className="size-3.5" aria-hidden="true" /></button>
    </li>)}</ul>}
    <label htmlFor={id} className="sr-only">{label}</label>
    <textarea id={id} value={value} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
      maxLength={4000} rows={1} placeholder={placeholder} className={`block w-full resize-none bg-transparent [field-sizing:content] outline-none! ${compact ? "max-h-48 min-h-10 px-2.5 py-2 text-sm" : "max-h-60 min-h-12 px-3 py-2.5 text-[15px]"}`} />
    <div className={`flex items-center justify-between gap-3 ${compact ? "pl-2.5" : "pl-3"}`}>
      <div className="flex min-w-0 items-center gap-2">
        {/* On phones the picker offers the camera as well as files. */}
        {attachments && <label className={`flex shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground has-disabled:cursor-default has-disabled:opacity-40 ${compact ? "size-8" : "size-9"}`} title="Attach a photo or PDF">
          <span className="sr-only">Attach a photo or PDF</span><Paperclip className="size-4" aria-hidden="true" />
          <input type="file" accept="image/*,application/pdf" multiple disabled={disabled || attachments.full} className="sr-only" onChange={event => { if (event.target.files) attachments.add(event.target.files); event.target.value = ""; }} />
        </label>}
        <span role={busy ? "status" : undefined} className="truncate text-xs text-muted-foreground">{busy ? busyText : ""}</span>
      </div>
      <div className="flex items-center gap-1.5">{voice && <VoiceInput compact={compact} disabled={disabled} onSend={voice.onSend}
          onDone={text => { onChange(withSpoken(value, text)); document.getElementById(id)?.focus(); }} />}
        {busy && <button type="button" onClick={onStop} aria-label="Stop" className={button}><Square className={`${compact ? "size-3" : "size-3.5"} fill-current`} aria-hidden="true" /></button>}
        {/* While a reply runs, sending queues the message. */}
        {(!busy || value.trim()) && <button disabled={disabled || !sendable} aria-label={busy ? "Queue message" : "Send"} className={`${button} disabled:opacity-30`}><ArrowUp className={compact ? "size-4" : "size-5"} aria-hidden="true" /></button>}</div></div>
  </form>;
}
