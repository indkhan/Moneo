import { useEffect, useState } from "react";
import { startVoiceRecording, type VoiceHandlers, type VoiceRecording } from "./voice-recorder";

export const VOICE_MAX_SECONDS = 120;

export type VoiceStatus = "idle" | "starting" | "recording" | "finishing";
export type VoiceAction = "send" | "done";
export type VoiceState = { status: VoiceStatus; text: string; level: number; error: string; startedAt: number };
export const IDLE_VOICE: VoiceState = { status: "idle", text: "", level: 0, error: "", startedAt: 0 };

/**
 * One mic, the same for a tap or a hold: start records with live words; Send and Done both stop and hand the
 * transcript over (`send` straight away, `done` into the input to edit); cancel throws it away.
 * Hitting the length limit acts as Done, so nothing said is lost.
 */
export function createVoiceInput({ record, onFinish, onChange, maxSeconds = VOICE_MAX_SECONDS, now = Date.now }: {
  record: (handlers: VoiceHandlers) => Promise<VoiceRecording>; onFinish: (action: VoiceAction, text: string) => void;
  onChange: (state: VoiceState) => void; maxSeconds?: number; now?: () => number;
}) {
  let state = IDLE_VOICE, recording: VoiceRecording | null = null, run = 0, limit: ReturnType<typeof setTimeout> | undefined, finished = onFinish;
  const set = (patch: Partial<VoiceState>) => { state = { ...state, ...patch }; onChange(state); };
  // Each start, stop or cancel begins a new run, so late events from an older one are ignored.
  const reset = (patch: Partial<VoiceState> = {}) => { run++; clearTimeout(limit); recording = null; set({ ...IDLE_VOICE, ...patch }); };

  async function start() {
    if (state.status !== "idle") return;
    const current = ++run;
    set({ ...IDLE_VOICE, status: "starting" });
    const live = <T>(handler: (value: T) => void) => (value: T) => { if (current === run) handler(value); };
    try {
      const next = await record({ onText: live<string>(text => set({ text })), onLevel: live<number>(level => set({ level })), onError: live(fail) });
      if (current !== run) return next.cancel();
      recording = next;
      set({ status: "recording", startedAt: now() });
      limit = setTimeout(() => void finish("done"), maxSeconds * 1000);
    } catch (error) { if (current === run) fail(error); }
  }

  async function finish(action: VoiceAction) {
    if (state.status !== "recording" || !recording) return;
    const current = run, active = recording;
    clearTimeout(limit);
    set({ status: "finishing", level: 0 });
    const heard = (await active.stop().catch(() => state.text)).trim() || state.text.trim();
    if (current !== run) return;
    reset(heard ? {} : { error: "Didn't catch that. Try again." });
    if (heard) finished(action, heard);
  }

  function cancel() {
    recording?.cancel();
    if (state.status !== "idle" || state.error) reset();
  }

  // A dropped connection keeps what was already heard in the input instead of losing it.
  function fail(error: unknown) {
    const heard = state.text.trim();
    recording?.cancel();
    reset({ error: error instanceof Error ? error.message : "Voice input failed. Try again." });
    if (heard) finished("done", heard);
  }

  return { start, send: () => finish("send"), done: () => finish("done"), cancel, get state() { return state; },
    /** Swaps in the latest handler, so a re-rendered composer sees its current text. */
    setOnFinish: (handler: typeof onFinish) => { finished = handler; } };
}

/** React binding for the shared voice input; recording stops if the composer unmounts. */
export function useVoiceInput(onFinish: (action: VoiceAction, text: string) => void, record = startVoiceRecording) {
  const [state, setState] = useState(IDLE_VOICE);
  const [voice] = useState(() => createVoiceInput({ record, onFinish, onChange: setState }));
  useEffect(() => voice.setOnFinish(onFinish));
  useEffect(() => () => voice.cancel(), [voice]);
  return { ...state, start: voice.start, send: voice.send, done: voice.done, cancel: voice.cancel };
}
