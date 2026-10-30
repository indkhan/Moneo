"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Mic, X } from "lucide-react";
import { useVoiceInput, VOICE_MAX_SECONDS } from "@/lib/ai/use-voice-input";

const clock = (ms: number) => { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; };

/**
 * The mic for a text input. A tap or a hold both start recording (on release, which Safari needs for the mic);
 * live words show over the input with a level meter, then Send sends them, Done puts them in the input to edit,
 * and Cancel or Escape discards them. Put it inside a `relative` form: the recording view covers that form.
 */
export function VoiceInput({ onSend, onDone, autoStart = false, disabled = false, compact = false }: {
  onSend: (text: string) => void; onDone: (text: string) => void; autoStart?: boolean; disabled?: boolean; compact?: boolean;
}) {
  const voice = useVoiceInput((action, text) => action === "send" ? onSend(text) : onDone(text));
  const { status, start } = voice;
  const mic = useRef<HTMLButtonElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const words = useRef<HTMLParagraphElement>(null);
  const wasActive = useRef(false);
  const [now, setNow] = useState(0);
  useEffect(() => { if (autoStart) void start(); }, [autoStart, start]);
  useEffect(() => {
    if (status === "recording") done.current?.focus();
    // Send and Cancel leave nothing focused; Done hands focus to the input itself.
    if (status === "idle" && wasActive.current && (!document.activeElement || document.activeElement === document.body)) mic.current?.focus();
    wasActive.current = status !== "idle";
    if (status !== "recording") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);
  useEffect(() => { words.current?.scrollTo({ top: words.current.scrollHeight }); }, [voice.text]);

  const active = status !== "idle";
  const icon = compact ? "size-8" : "size-9";
  const action = "inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ai disabled:opacity-40";
  const label = status === "starting" ? "Starting the microphone…" : status === "finishing" ? "Finishing…" : "Listening…";
  return <>
    <button ref={mic} type="button" onClick={() => void start()} onContextMenu={event => event.preventDefault()} disabled={disabled || active}
      aria-label="Talk: record a voice message" title="Talk" className={`flex shrink-0 touch-manipulation items-center justify-center rounded-lg text-muted-foreground transition-colors select-none hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ai disabled:opacity-40 ${icon}`}>
      <Mic className="size-4" aria-hidden="true" /></button>
    {voice.error && !active && <p role="alert" className="absolute bottom-full left-0 mb-2 flex max-w-full items-center gap-2 rounded-lg border border-danger/30 bg-danger-soft py-1 pr-1 pl-3 text-xs text-danger shadow-sm">
      {voice.error}<button type="button" onClick={voice.cancel} aria-label="Dismiss" className="grid size-7 place-items-center rounded-md hover:bg-danger/10"><X className="size-3.5" aria-hidden="true" /></button></p>}
    {active && <div role="group" aria-label="Voice message" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); voice.cancel(); } }}
      className="absolute inset-0 z-10 flex min-h-28 flex-col gap-2 rounded-2xl border border-ai-border bg-card p-2.5 shadow-[0_0_0_3px_var(--color-ai-soft)]">
      <p ref={words} aria-live="polite" className={`min-h-0 flex-1 overflow-y-auto px-1 whitespace-pre-wrap ${compact ? "text-sm" : "text-[15px]"} ${voice.text ? "" : "text-muted-foreground"}`}>{voice.text || label}</p>
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-2 pl-1" aria-hidden="true"><span className={`size-2 rounded-full bg-danger ${status === "recording" ? "motion-safe:animate-pulse" : "opacity-40"}`} />
          <span className="flex h-6 items-center gap-[3px]">{[0.45, 0.7, 1, 0.8, 0.55, 0.35].map((scale, index) =>
            <span key={index} className="w-[3px] rounded-full bg-ai transition-[height] duration-100" style={{ height: `${4 + Math.round(voice.level * scale * 18)}px` }} />)}</span></span>
        <span className="font-mono text-xs text-muted-foreground"><span className="sr-only">Recording </span>{clock(status === "recording" ? Math.max(0, now - voice.startedAt) : 0)} / {clock(VOICE_MAX_SECONDS * 1000)}</span>
        <span className="ml-auto" />
        <button type="button" onClick={() => { voice.cancel(); mic.current?.focus(); }} aria-label="Cancel and discard recording" className={`${action} text-muted-foreground hover:bg-muted hover:text-foreground`}><X className="size-4" aria-hidden="true" /><span className="max-sm:sr-only">Cancel</span></button>
        <button ref={done} type="button" onClick={() => void voice.done()} disabled={status !== "recording"} aria-label="Done: put the words in the box to edit" className={`${action} border border-input hover:bg-muted`}><Check className="size-4" aria-hidden="true" />Done</button>
        <button type="button" onClick={() => void voice.send()} disabled={status !== "recording"} aria-label="Send now" className={`${action} bg-primary text-primary-foreground hover:opacity-90`}><ArrowUp className="size-4" aria-hidden="true" />Send</button>
      </div>
    </div>}
  </>;
}
