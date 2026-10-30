"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, MicOff, PhoneOff, Send, X } from "lucide-react";
import { IouCard } from "@/components/iou-card";
import { useVoiceCall } from "@/lib/ai/use-voice-call";
import type { ChatAnswer } from "@/lib/ai/use-chat-request";

/** The orb follows whoever is talking; it holds still when reduced motion is asked for. */
function Orb({ levels, state }: { levels: () => { mic: number; moneo: number }; state: "connecting" | "listening" | "thinking" | "speaking" | "idle" }) {
  const orb = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0, smooth = 0;
    const tick = () => {
      const { mic, moneo } = levels();
      smooth += (Math.max(mic, moneo) - smooth) * 0.25;
      orb.current?.style.setProperty("--level", smooth.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [levels]);
  const tone = state === "speaking" ? "from-lime to-brand" : state === "thinking" ? "from-ai to-ai-border" : "from-ai-border to-lime";
  return <div aria-hidden="true" className="relative grid size-40 place-items-center sm:size-48">
    <div className={`absolute inset-0 rounded-full bg-gradient-to-br ${tone} opacity-25 blur-2xl transition-colors duration-500`} />
    <div ref={orb} style={{ transform: "scale(calc(1 + var(--level, 0) * 0.35))" }}
      className={`size-28 rounded-full bg-gradient-to-br ${tone} shadow-[0_0_60px_-10px] shadow-ai/50 transition-colors duration-500 sm:size-32 ${state === "thinking" || state === "connecting" ? "motion-safe:animate-pulse" : ""}`} />
  </div>;
}

/** A live voice call with Moneo: speak or type, see captions and running tasks, and tap the cards it makes. */
export function VoiceCall({ conversationId, onAnswer, onEnded, onClose }: { conversationId: string; onAnswer: (question: string, answer: ChatAnswer) => void; onEnded: () => void; onClose: () => void }) {
  const call = useVoiceCall(conversationId, onAnswer, onEnded);
  const [text, setText] = useState("");
  const captions = useRef<HTMLDivElement>(null);
  useEffect(() => { captions.current?.scrollTo({ top: captions.current.scrollHeight }); }, [call.captions]);
  const last = call.captions.at(-1);
  const state = call.status === "connecting" ? "connecting" : call.status !== "live" ? "idle" : last?.role === "assistant" && !call.thinking ? "speaking" : call.thinking ? "thinking" : "listening";
  const label = { connecting: "Connecting…", listening: call.muted ? "Muted" : "Listening", thinking: "Working on it", speaking: "Moneo is talking", idle: call.status === "ended" ? "Call ended" : "Call failed" }[state];
  const running = call.tasks.filter(task => task.status === "running");
  const round = "grid size-14 place-items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ai";

  return <section role="dialog" aria-modal="true" aria-label="Voice call with Moneo" className="fixed inset-0 z-50 flex flex-col bg-background lg:sticky lg:top-19 lg:z-auto lg:h-[calc(100dvh-4.75rem)]">
    <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-8">
      <p className="font-display text-lg font-semibold">Call with Moneo</p>
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">{state === "connecting" && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />}{label}</p>
    </header>
    <div className="mx-auto flex min-h-0 w-full max-w-[820px] flex-1 flex-col gap-4 overflow-y-auto px-4 py-6 sm:px-8">
      <div className="flex flex-col items-center gap-2"><Orb levels={call.levels} state={state} /></div>
      {call.error && <p role="alert" className="rounded-lg border border-danger/40 px-3 py-2 text-sm text-danger">{call.error}</p>}
      <div ref={captions} aria-live="polite" aria-label="Live captions" className="max-h-48 space-y-2 overflow-y-auto text-[15px] leading-relaxed">
        {!call.captions.length && call.status === "live" && <p className="text-center text-muted-foreground">Say hi, ask about your money, or tell Moneo what you spent.</p>}
        {call.captions.slice(-8).map(caption => <p key={caption.id} className={caption.role === "user" ? "ml-auto w-fit max-w-[85%] rounded-2xl bg-muted px-3 py-1.5" : "max-w-[90%]"}>
          <span className="sr-only">{caption.role === "user" ? "You: " : "Moneo: "}</span>{caption.text}</p>)}
      </div>
      {call.tasks.length > 0 && <div>
        <p className="eyebrow pb-1.5">{running.length ? `Working on ${running.length}` : "Done"}</p>
        <ul className="space-y-1.5" aria-label="Tasks">
          {call.tasks.slice(-6).map(task => <li key={task.requestId} className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm">
            {task.status === "running" ? <Loader2 className="size-4 shrink-0 text-ai motion-safe:animate-spin" aria-hidden="true" /> : <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${task.status === "done" ? "bg-success" : task.status === "failed" ? "bg-danger" : "bg-subtle"}`} />}
            <span className="min-w-0 flex-1"><span className="block truncate">{task.text}</span><span className="block text-xs text-muted-foreground">{task.step}</span></span>
            {task.status === "running" && <button type="button" onClick={() => void call.cancel(task.requestId)} aria-label={`Stop “${task.text}”`} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" aria-hidden="true" /></button>}
          </li>)}
        </ul>
      </div>}
      {call.cards.length > 0 && <div aria-label="Cards to review" role="region">
        <p className="eyebrow">Tap to save · nothing is saved until you do</p>
        {call.cards.map(id => <IouCard key={id} id={id} />)}
      </div>}
    </div>
    <footer className="border-t border-border px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-8">
      <form onSubmit={event => { event.preventDefault(); call.typed(text); setText(""); }} className="mx-auto flex max-w-[820px] items-center gap-2">
        <label className="sr-only" htmlFor="call-text">Type to Moneo</label>
        <input id="call-text" value={text} onChange={event => setText(event.target.value)} maxLength={4000} placeholder="Or type here…" autoComplete="off"
          className="min-w-0 flex-1 rounded-full border border-border bg-card px-4 py-2.5 text-sm focus:border-muted-foreground/40 focus:outline-none" />
        <button aria-label="Send" disabled={!text.trim()} className="grid size-10 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"><Send className="size-4" aria-hidden="true" /></button>
      </form>
      <div className="mt-3 flex items-center justify-center gap-6">
        <button type="button" onClick={call.toggleMute} aria-pressed={call.muted} aria-label={call.muted ? "Unmute" : "Mute"} disabled={call.status !== "live"}
          className={`${round} ${call.muted ? "bg-foreground text-background" : "bg-muted hover:bg-accent"} disabled:opacity-40`}>{call.muted ? <MicOff className="size-5" aria-hidden="true" /> : <Mic className="size-5" aria-hidden="true" />}</button>
        <button type="button" onClick={onClose} aria-label={call.status === "live" || call.status === "connecting" ? "End call" : "Close"} className={`${round} bg-danger text-white hover:opacity-90`}><PhoneOff className="size-5" aria-hidden="true" /></button>
      </div>
    </footer>
  </section>;
}
