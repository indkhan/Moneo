"use client";

import { useEffect, useReducer, useState } from "react";
import { readResponse, type ChatAnswer } from "./use-chat-request";
import { VoiceCallController, type CallAsk } from "./voice-call-controller";
import { boundTranscript } from "./voice-call-record";

export type CallStatus = "connecting" | "live" | "ended" | "error";

function failure(cause: unknown) {
  const name = cause instanceof DOMException ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was denied. Allow it in your browser to call Moneo.";
  if (name === "NotFoundError") return "No microphone was found.";
  return cause instanceof Error && cause.message ? cause.message : "Could not connect the call. Check your connection and try again.";
}

/** Average loudness (0-1) of an analyser's current frame. */
function level(analyser: AnalyserNode | null, buffer: Uint8Array<ArrayBuffer>) {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (const value of buffer) sum += ((value - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(sum / buffer.length) * 4);
}

/** In development, a timed trace of the call (events, who is audible, what the controller decided) in the console and the dev server log. */
const trace = process.env.NODE_ENV === "production" ? undefined : (message: string) => console.info(`[call ${new Date().toISOString().slice(11, 23)}] ${message}`);

/** Connection handles live outside React state; the controller, effect and orb share them. */
class Connection {
  channel: RTCDataChannel | null = null;
  mic: MediaStream | null = null;
  micLevel: AnalyserNode | null = null;
  moneoLevel: AnalyserNode | null = null;
  readonly aborts = new Map<string, AbortController>();
  /** The call's id and when it went live, for the record saved at hang-up. */
  readonly callId = crypto.randomUUID();
  startedAt: number | null = null;
  constructor(public onAnswer?: (question: string, answer: ChatAnswer) => void, public onEnded?: () => void) {}
  set(patch: Partial<Pick<Connection, "channel" | "mic" | "micLevel" | "moneoLevel" | "onAnswer" | "onEnded">>) { Object.assign(this, patch); }
}

/**
 * A live GPT-Live call over WebRTC. GPT-Live only talks; every question it hands off runs through /api/chat
 * in this conversation (see VoiceCallController), and the answer is sent back for it to speak.
 */
export function useVoiceCall(conversationId: string, onAnswer?: (question: string, answer: ChatAnswer) => void, onEnded?: () => void) {
  const [status, setStatus] = useState<CallStatus>("connecting");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [, render] = useReducer((count: number) => count + 1, 0);
  const [live] = useState(() => new Connection(onAnswer, onEnded));
  useEffect(() => { live.set({ onAnswer, onEnded }); });

  const [controller] = useState(() => {
    const ask: CallAsk = async (payload, onEvent) => {
      const abort = new AbortController();
      live.aborts.set(payload.requestId, abort);
      try {
        const response = await fetch("/api/chat", { method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, application/json" }, body: JSON.stringify(payload) });
        return await readResponse(response, onEvent);
      } finally { live.aborts.delete(payload.requestId); }
    };
    return new VoiceCallController({ conversationId, ask, onChange: render, onAnswer: (question, answer) => live.onAnswer?.(question, answer),
      log: trace,
      send: event => {
        trace?.(`sent ${event.type}: ${String(event.content ?? "").slice(0, 100)}`);
        if (live.channel?.readyState === "open") live.channel.send(JSON.stringify(event));
      } });
  });

  useEffect(() => {
    let closed = false;
    const pc = typeof RTCPeerConnection === "undefined" ? null : new RTCPeerConnection();
    const audio = new Audio();
    audio.autoplay = true;
    let context: AudioContext | null = null, wakeLock: WakeLockSentinel | null = null;
    const lock = () => { if (document.visibilityState === "visible") navigator.wakeLock?.request("screen").then(sentinel => { if (closed) void sentinel.release(); else wakeLock = sentinel; }, () => {}); };
    async function connect() {
      if (!pc || !navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot make voice calls. Try a recent Chrome, Safari or Firefox.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (closed) { stream.getTracks().forEach(track => track.stop()); return; }
      live.set({ mic: stream });
      context = new AudioContext();
      const analyser = (source: MediaStream) => { const node = context!.createAnalyser(); node.fftSize = 512; context!.createMediaStreamSource(source).connect(node); return node; };
      live.set({ micLevel: analyser(stream) });
      pc.addTrack(stream.getAudioTracks()[0], stream);
      pc.ontrack = event => { audio.srcObject = event.streams[0]; live.set({ moneoLevel: analyser(event.streams[0]) }); };
      const dc = pc.createDataChannel("oai-events");
      live.set({ channel: dc });
      dc.onmessage = message => {
        const event = JSON.parse(message.data);
        if (event.type === "session.started") { setStatus("live"); live.startedAt ??= Date.now(); lock(); }
        else if (event.type === "session.closed") setStatus("ended");
        if (trace && event.type !== "session.output_audio.delta") trace(`${event.type}${event.delta !== undefined ? ` ${JSON.stringify(event.delta)}` : ""}${event.start_ms !== undefined ? ` ${event.start_ms}-${event.end_ms}ms` : ""}${event.offset_ms != null ? ` offset ${event.offset_ms}ms` : ""}`);
        controller.handle(event);
      };
      pc.onconnectionstatechange = () => { if (!closed && pc.connectionState === "failed") { setStatus("error"); setError("The call dropped. Check your connection and try again."); } };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const response = await fetch("/api/voice/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sdp: offer.sdp, conversationId }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not start the call");
      if (!closed) await pc.setRemoteDescription({ type: "answer", sdp: body.sdp });
    }
    /** Hanging up saves the call in the chat; keepalive lets it finish even if the tab is closing. */
    function saveRecord() {
      const transcript = boundTranscript(controller.captions);
      if (live.startedAt === null || !transcript.length) return;
      const seconds = Math.min(86_400, Math.round((Date.now() - live.startedAt) / 1000));
      live.startedAt = null;
      // Answers that land after hang-up are saved by the server and shown inside the call.
      const finished = live.onEnded;
      live.set({ onAnswer: undefined });
      void fetch("/api/voice/calls", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: live.callId, conversationId, durationSeconds: seconds, transcript,
          tasks: controller.tasks.slice(-30).map(task => ({ requestId: task.requestId, text: task.text.slice(0, 300), status: task.status })) }) })
        .then(response => { if (response.ok) finished?.(); }, () => {});
    }
    connect().catch(cause => { if (!closed) { setStatus("error"); setError(failure(cause)); } });
    // Moneo's voice, metered: what the user actually hears decides when a result has been said.
    const buffer = new Uint8Array(512);
    let moneoOn = false, micOn = false;
    const meter = setInterval(() => {
      const moneo = level(live.moneoLevel, buffer) > 0.02, mic = level(live.micLevel, buffer) > 0.08;
      if (moneo) controller.heardMoneo();
      if (trace && moneo !== moneoOn) trace(moneo ? "Moneo audible" : "Moneo quiet");
      if (trace && mic !== micOn) trace(mic ? "mic loud" : "mic quiet");
      moneoOn = moneo; micOn = mic;
    }, 100);
    document.addEventListener("visibilitychange", lock);
    return () => {
      closed = true;
      clearInterval(meter);
      saveRecord();
      document.removeEventListener("visibilitychange", lock);
      try { if (live.channel?.readyState === "open") live.channel.send(JSON.stringify({ type: "session.close" })); } catch { /* already closed */ }
      live.set({ channel: null, micLevel: null, moneoLevel: null });
      live.mic?.getTracks().forEach(track => track.stop());
      pc?.close();
      audio.srcObject = null;
      void context?.close();
      void wakeLock?.release();
    };
  }, [controller, conversationId, live]);

  function toggleMute() {
    const next = !muted;
    live.mic?.getAudioTracks().forEach(track => { track.enabled = !next; });
    setMuted(next);
  }

  async function cancel(requestId: string) {
    controller.cancel(requestId);
    // Cancellation can arrive before the server has claimed the request.
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await fetch("/api/chat", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }) }).catch(() => null);
      if (response?.status !== 404) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    live.aborts.get(requestId)?.abort();
  }

  /** Current loudness of the user's mic and of Moneo's voice, for the orb; read every frame without re-rendering. */
  const [levels] = useState(() => {
    const buffer = new Uint8Array(512);
    return () => ({ mic: level(live.micLevel, buffer), moneo: level(live.moneoLevel, buffer) });
  });

  return {
    status, error: error || controller.error, muted, toggleMute, cancel, levels,
    captions: controller.captions, tasks: controller.tasks, cards: controller.cards,
    typed: (text: string) => controller.typed(text),
    /** Moneo is answering or working; used for the orb's thinking state. */
    thinking: controller.running.length > 0,
  };
}
