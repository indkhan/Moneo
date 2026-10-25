import { ArrowUp, Square } from "lucide-react";

/** Composer shared by the AI page and the Ask Moneo panel. Enter sends (or queues while busy), Shift+Enter adds a line. */
export function ChatComposer({ id, label, value, onChange, onSubmit, onStop, busy, disabled = false, placeholder, compact = false, busyText }: {
  id: string; label: string; value: string; onChange: (value: string) => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onStop: () => void; busy: boolean; disabled?: boolean; placeholder: string; compact?: boolean; busyText: string;
}) {
  const button = `flex items-center justify-center rounded-xl bg-primary text-primary-foreground hover:opacity-90 ${compact ? "size-9" : "size-11"}`;
  return <form onSubmit={onSubmit} className="rounded-2xl border border-input bg-card p-2.5 transition-colors focus-within:border-muted-foreground/60">
    <label htmlFor={id} className="sr-only">{label}</label>
    <textarea id={id} value={value} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
      maxLength={4000} rows={1} placeholder={placeholder} className={`block w-full resize-none bg-transparent [field-sizing:content] outline-none! ${compact ? "max-h-48 min-h-10 px-2.5 py-2 text-sm" : "max-h-60 min-h-12 px-3 py-2.5 text-[15px]"}`} />
    <div className={`flex items-center justify-between gap-3 ${compact ? "pl-2.5" : "pl-3"}`}><span role={busy ? "status" : undefined} className="text-xs text-muted-foreground">{busy ? busyText : ""}</span>
      <div className="flex gap-1.5">{busy && <button type="button" onClick={onStop} aria-label="Stop" className={button}><Square className={`${compact ? "size-3" : "size-3.5"} fill-current`} aria-hidden="true" /></button>}
        {/* While a reply runs, sending queues the message. */}
        {(!busy || value.trim()) && <button disabled={disabled || !value.trim()} aria-label={busy ? "Queue message" : "Send"} className={`${button} disabled:opacity-30`}><ArrowUp className={compact ? "size-4" : "size-5"} aria-hidden="true" /></button>}</div></div>
  </form>;
}
