"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowUp, Ban, CheckCircle2, Keyboard, Loader2, Mic, MicOff, PhoneOff, X } from "lucide-react";
import { IouCard } from "@/components/iou-card";
import { useVoiceCall } from "@/lib/ai/use-voice-call";
import type { ChatAnswer } from "@/lib/ai/use-chat-request";

type OrbState = "connecting" | "listening" | "muted" | "thinking" | "speaking" | "idle";
const ORB_TONES: Record<OrbState, string> = {
  connecting: "[--orb-a:var(--color-ai-border)] [--orb-b:var(--color-ai-soft)]",
  listening: "[--orb-a:var(--color-ai)] [--orb-b:var(--color-ai-border)]",
  muted: "[--orb-a:var(--color-subtle)] [--orb-b:var(--color-muted)]",
  thinking: "[--orb-a:var(--color-ai)] [--orb-b:var(--color-lime)]",
  speaking: "[--orb-a:var(--color-lime)] [--orb-b:var(--color-brand)]",
  idle: "[--orb-a:var(--color-input)] [--orb-b:var(--color-muted)]",
};

/** The orb follows whoever is talking: its glow and ring swell with the voice, it turns while Moneo works, and it holds still for reduced motion. */
function Orb({ levels, state }: { levels: () => { mic: number; moneo: number }; state: OrbState }) {
  const orb = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0, smooth = 0;
    const tick = () => {
      const { mic, moneo } = levels();
      smooth += (Math.max(mic, moneo) - smooth) * 0.2;
      orb.current?.style.setProperty("--level", smooth.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [levels]);
  const still = state === "idle" || state === "muted";
  return <div ref={orb} aria-hidden="true" className={`relative grid size-52 shrink-0 place-items-center ${ORB_TONES[state]}`}>
    <div className="absolute inset-2 rounded-full bg-[radial-gradient(circle,var(--orb-a),transparent_68%)] opacity-45 blur-2xl" style={{ transform: "scale(calc(1 + var(--level, 0) * 0.5))" }} />
    <div className="absolute inset-5 rounded-full border border-[color-mix(in_oklab,var(--orb-a)_40%,transparent)]" style={{ transform: "scale(calc(1 + var(--level, 0) * 0.3))" }} />
    <div className={still ? "" : "motion-safe:animate-orb-breathe"}>
      <div className="relative size-32 overflow-hidden rounded-full shadow-[inset_0_-10px_30px_rgb(0_0_0/0.18),0_14px_40px_-14px_var(--orb-a)]" style={{ transform: "scale(calc(1 + var(--level, 0) * 0.14))" }}>
        <div className={`absolute -inset-1/4 blur-md bg-[conic-gradient(from_90deg,var(--orb-a),var(--orb-b),var(--orb-a))] ${state === "thinking" || state === "connecting" ? "motion-safe:animate-orb-spin" : ""}`} />
        <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_32%_28%,rgb(255_255_255/0.5),transparent_48%)]" />
      </div>
    </div>
  </div>;
}

/** A live voice call with Moneo: speak or type, see the requests it is working on, and tap the cards it makes. The full transcript is saved with the call. */
export function VoiceCall({ conversationId, onAnswer, onEnded, onClose }: { conversationId: string; onAnswer: (question: string, answer: ChatAnswer) => void; onEnded: () => void; onClose: () => void }) {
  return <VoiceCallView call={useVoiceCall(conversationId, onAnswer, onEnded)} onClose={onClose} />;
}

/** How long the call has been live, as a phone shows it (0:42, 1:05:09); empty until it is. */
function useElapsed(live: boolean) {
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!live) return;
    const start = performance.now();
    const tick = () => setSeconds(Math.floor((performance.now() - start) / 1000));
    const timer = window.setInterval(tick, 1000);
    const first = window.setTimeout(tick, 0);
    return () => { window.clearInterval(timer); window.clearTimeout(first); };
  }, [live]);
  if (seconds === null) return "";
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, "0")}` : minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The call screen for a call's state, kept apart from the connection so each state can be rendered alone. */
export function VoiceCallView({ call, onClose }: { call: ReturnType<typeof useVoiceCall>; onClose: () => void }) {
  const [text, setText] = useState("");
  // Phones keep the call screen clean: the text field opens from the Keypad button, as on a phone call.
  const [typing, setTyping] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight }); }, [call.tasks]);
  const live = call.status === "live";
  const open = live || call.status === "connecting";
  const state: OrbState = call.status === "connecting" ? "connecting" : !live ? "idle" : call.talking ? "speaking" : call.thinking ? "thinking" : call.muted ? "muted" : "listening";
  const label = { connecting: "Connecting…", listening: "Listening", muted: "You're muted", thinking: "Working on it", speaking: "Moneo is talking", idle: call.status === "ended" ? "Call ended" : "Call dropped" }[state];
  const running = call.tasks.filter(task => task.status === "running");
  const elapsed = useElapsed(live);
  const busy = call.tasks.length > 0 || call.cards.length > 0;
  const round = "grid size-16 place-items-center rounded-full transition-[background-color,transform] active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ai disabled:opacity-40";

  return <section role="dialog" aria-modal="true" aria-label="Voice call with Moneo" className="fixed inset-0 z-50 flex flex-col bg-background max-lg:bg-[radial-gradient(120%_55%_at_50%_0%,var(--color-ai-soft),var(--color-background)_75%)] lg:sticky lg:top-19 lg:z-auto lg:h-[calc(100dvh-4.75rem)]">
    <header className="flex items-center justify-between gap-3 border-b border-border px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 max-lg:flex-col max-lg:gap-1 max-lg:border-0 max-lg:pt-[calc(env(safe-area-inset-top)+2.5rem)] max-lg:pb-0 sm:px-8 lg:pt-3">
      <p className="font-display text-lg font-semibold max-lg:text-[32px] max-lg:leading-tight max-lg:tracking-tight"><span className="max-lg:hidden">Call with </span>Moneo</p>
      <p aria-hidden="true" className="text-[15px] text-muted-foreground tabular-nums lg:hidden">{elapsed || label}</p>
      {live && <span className="max-lg:hidden inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-xs font-medium text-success"><span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden="true" />Live</span>}
    </header>
    <div ref={body} className="mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col overflow-y-auto px-4 sm:px-8">
      <div className={`flex flex-col items-center pt-4 sm:pt-8 ${busy ? "" : "max-lg:my-auto max-lg:pb-10"}`}>
        {/* Once requests and cards fill the screen, the orb shrinks on phones so they stay in view. */}
        <div className={busy ? "max-lg:-mt-4 max-lg:-mb-8 max-lg:scale-[0.62]" : ""}><Orb levels={call.levels} state={state} /></div>
        <p role="status" className="flex h-7 items-center gap-2 font-display text-lg font-medium">{state === "connecting" && <Loader2 className="size-4 text-ai motion-safe:animate-spin" aria-hidden="true" />}{label}</p>
        {!call.tasks.length && live && <p className="mt-6 max-w-xs text-center text-[15px] text-muted-foreground sm:max-w-none sm:text-base">Say hi, ask about your money, or tell Moneo what you spent.</p>}
      </div>
      {call.error && <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger"><AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{call.error}</p>}
      {call.tasks.length > 0 && <div className="mt-5">
        <p className="eyebrow pb-2">{running.length ? `Working on ${running.length} of ${call.tasks.length}` : "All done"}</p>
        <ul className="space-y-1.5" aria-label="Tasks">
          {call.tasks.slice(-6).map(task => <li key={task.requestId} className="flex min-h-14 items-center gap-3 rounded-xl border border-border bg-card py-1.5 pr-1 pl-3.5 text-sm">
            <TaskIcon status={task.status} />
            <span className="min-w-0 flex-1"><span className="block truncate font-medium">{task.title ?? (task.status === "running" ? <><span aria-hidden="true" className="my-1 block h-3 w-40 max-w-full rounded bg-muted motion-safe:animate-pulse" /><span className="sr-only">{task.text}</span></> : task.text)}</span><span className={`block text-xs first-letter:uppercase ${task.status === "failed" ? "text-danger" : "text-muted-foreground"}`}>{task.step}</span></span>
            {(task.status === "running" || call.unsaid.has(task.requestId)) && <button type="button" onClick={() => void call.cancel(task.requestId)} aria-label={`Stop “${task.title ?? task.text}”`} className="grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ai"><X className="size-4" aria-hidden="true" /></button>}
          </li>)}
        </ul>
      </div>}
      {call.cards.length > 0 && <div aria-label="Cards to review" role="region" className="mt-5">
        <p className="eyebrow">Tap to save · nothing is saved until you do</p>
        {call.cards.map(id => <IouCard key={id} id={id} />)}
      </div>}
      <div className="h-4 shrink-0" />
    </div>
    <footer className="border-t border-border px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] max-lg:border-0 max-lg:pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:px-8">
      {/* Typed before the call is live, the answer would have no voice to say it. */}
      {live && <form onSubmit={event => { event.preventDefault(); call.typed(text); setText(""); }} className={`mx-auto mb-4 flex max-w-[720px] items-center gap-2 ${typing ? "" : "max-lg:hidden"}`}>
        <label className="sr-only" htmlFor="call-text">Type to Moneo</label>
        <input id="call-text" autoFocus={typing} value={text} onChange={event => setText(event.target.value)} maxLength={4000} placeholder="Or type a message…" autoComplete="off"
          className="h-11 min-w-0 flex-1 rounded-full border border-input bg-card px-4 text-[15px] transition-colors focus:border-muted-foreground/60 focus:outline-none" />
        <button aria-label="Send" disabled={!text.trim()} className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ai disabled:opacity-30"><ArrowUp className="size-5" aria-hidden="true" /></button>
      </form>}
      <div className="flex items-start justify-center gap-10 max-lg:gap-8">
        <div className="flex flex-col items-center gap-1.5">
          <button type="button" onClick={call.toggleMute} aria-pressed={call.muted} aria-label={call.muted ? "Unmute" : "Mute"} disabled={!live}
            className={`${round} ${call.muted ? "bg-foreground text-background" : "border border-border bg-card hover:bg-muted"}`}>{call.muted ? <MicOff className="size-6" aria-hidden="true" /> : <Mic className="size-6" aria-hidden="true" />}</button>
          <span aria-hidden="true" className="text-xs text-muted-foreground">{call.muted ? "Unmute" : "Mute"}</span>
        </div>
        <div className="flex flex-col items-center gap-1.5 lg:hidden">
          <button type="button" onClick={() => setTyping(open => !open)} aria-pressed={typing} aria-label="Type a message" disabled={!live}
            className={`${round} ${typing ? "bg-foreground text-background" : "border border-border bg-card hover:bg-muted"}`}><Keyboard className="size-6" aria-hidden="true" /></button>
          <span aria-hidden="true" className="text-xs text-muted-foreground">Keypad</span>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <button type="button" onClick={onClose} aria-label={open ? "End call" : "Close"} className={`${round} bg-danger text-white hover:bg-danger/90`}>{open ? <PhoneOff className="size-6" aria-hidden="true" /> : <X className="size-6" aria-hidden="true" />}</button>
          <span aria-hidden="true" className="text-xs text-muted-foreground">{open ? "End" : "Close"}</span>
        </div>
      </div>
    </footer>
  </section>;
}

/** Where one task stands: a spinner while running, then a tick, a warning or a stop mark. */
function TaskIcon({ status }: { status: string }) {
  const icon = "size-4 shrink-0";
  if (status === "running") return <Loader2 className={`${icon} text-ai motion-safe:animate-spin`} aria-label="Running" />;
  if (status === "done") return <CheckCircle2 className={`${icon} text-success`} aria-label="Done" />;
  if (status === "failed") return <AlertCircle className={`${icon} text-danger`} aria-label="Failed" />;
  return <Ban className={`${icon} text-subtle`} aria-label="Stopped" />;
}
