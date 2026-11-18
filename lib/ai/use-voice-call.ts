"use client";

import { useEffect, useReducer, useState } from "react";
import { awaitedLater } from "@/lib/awaited-later";
import { readResponse, type ChatAnswer } from "./use-chat-request";
import { VoiceCallController, type CallAsk } from "./voice-call-controller";
import { boundTranscript } from "./voice-call-record";
import { VoicePlayback } from "./voice-playback";
import { announceCallRecord, indexedDbStore, postCallRecord, saveOrQueue } from "./voice-record-queue";

export type CallStatus = "connecting" | "live" | "ended" | "error";

function failure(cause: unknown) {
  const name = cause instanceof DOMException ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was denied. Allow it in your browser to call Moneo.";
  if (name === "NotFoundError") return "No microphone was found.";
  return cause instanceof Error && cause.message ? cause.message : "Could not connect the call. Check your connection and try again.";
}

function level(analyser: AnalyserNode | null, buffer: Uint8Array<ArrayBuffer>) {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (const value of buffer) sum += ((value - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(sum / buffer.length) * 4);
}

const sessionAlreadyClosed = () => undefined;
const screenMayStillSleep = () => undefined;
const trace = process.env.NODE_ENV === "production" ? undefined : (message: string) => console.info(`[call ${new Date().toISOString().slice(11, 23)}] ${message}`);

class Connection {
  channel: RTCDataChannel | null = null;
  mic: MediaStream | null = null;
  micLevel: AnalyserNode | null = null;
  moneoLevel: AnalyserNode | null = null;
  readonly aborts = new Map<string, AbortController>();
  readonly callId = crypto.randomUUID();
  startedAt: number | null = null;
  workspaceId: string | null = null;
  constructor(public onAnswer?: (question: string, answer: ChatAnswer) => void, public onEnded?: () => void) {}
  set(patch: Partial<Pick<Connection, "channel" | "mic" | "micLevel" | "moneoLevel" | "onAnswer" | "onEnded" | "workspaceId">>) { Object.assign(this, patch); }
}

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
    const playback = new VoicePlayback();
    let context: AudioContext | null = null, wakeLock: WakeLockSentinel | null = null;
    const lock = () => { if (document.visibilityState === "visible") navigator.wakeLock?.request("screen").then(sentinel => { if (closed) void sentinel.release(); else wakeLock = sentinel; }, screenMayStillSleep); };
    async function connect() {
      if (!pc || !navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot make voice calls. Try a recent Chrome, Safari or Firefox.");
      const slot = pc.addTransceiver("audio", { direction: "sendrecv" });
      pc.ontrack = event => { audio.srcObject = event.streams[0]; live.set({ moneoLevel: analyser(event.streams[0]) }); };
      const dc = pc.createDataChannel("oai-events");
      live.set({ channel: dc });
      dc.onmessage = message => {
        const event = JSON.parse(message.data);
        if (event.type === "session.input_transcript.delta") playback.transcript(event.delta ?? "");
        if (event.type === "session.started") { setStatus("live"); live.startedAt ??= Date.now(); lock(); }
        else if (event.type === "session.closed") setStatus("ended");
        if (trace && event.type !== "session.output_audio.delta") trace(`${event.type}${event.delta !== undefined ? ` ${JSON.stringify(event.delta)}` : ""}${event.start_ms !== undefined ? ` ${event.start_ms}-${event.end_ms}ms` : ""}${event.offset_ms != null ? ` offset ${event.offset_ms}ms` : ""}`);
        controller.handle(event);
      };
      pc.onconnectionstatechange = () => { if (!closed && pc.connectionState === "failed") { setStatus("error"); setError("The call dropped. Check your connection and try again."); } };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = awaitedLater(fetch("/api/voice/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sdp: offer.sdp, conversationId }) })
        .then(async response => { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error ?? "Could not start the call"); live.set({ workspaceId: body.workspaceId }); return body.sdp as string; }));
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (closed) { stream.getTracks().forEach(track => track.stop()); return; }
      live.set({ mic: stream });
      context = new AudioContext();
      live.set({ micLevel: analyser(stream) });
      await slot.sender.replaceTrack(stream.getAudioTracks()[0]);
      const sdp = await answer;
      if (!closed) await pc.setRemoteDescription({ type: "answer", sdp });
    }
    const analyser = (source: MediaStream) => { const node = context!.createAnalyser(); node.fftSize = 512; context!.createMediaStreamSource(source).connect(node); return node; };
    function saveRecord() {
      const transcript = boundTranscript(controller.captions);
      if (live.startedAt === null || !live.workspaceId || !transcript.length) return;
      const seconds = Math.min(86_400, Math.round((Date.now() - live.startedAt) / 1000));
      live.startedAt = null;
      const finished = live.onEnded;
      live.set({ onAnswer: undefined });
      const record = { id: live.callId, workspaceId: live.workspaceId, conversationId, durationSeconds: seconds, transcript,
        tasks: controller.tasks.slice(-30).map(task => ({ requestId: task.requestId, text: task.text.slice(0, 300), ...(task.title && { title: task.title }), status: task.status })) };
      void saveOrQueue(indexedDbStore, postCallRecord, record).then(result => {
        if (result.kind === "saved") finished?.();
        else announceCallRecord(result);
      });
    }
    connect().catch(cause => { if (!closed) { setStatus("error"); setError(failure(cause)); } });
    const buffer = new Uint8Array(512);
    let moneoOn = false, micOn = false, talking = false;
    const meter = setInterval(() => {
      const moneo = level(live.moneoLevel, buffer) > 0.02, mic = level(live.micLevel, buffer) > 0.08;
      audio.volume = playback.volume(Date.now(), mic, moneo);
      if (moneo && audio.volume > 0) controller.heardMoneo();
      if (mic) controller.heardUser();
      if (trace && moneo !== moneoOn) trace(moneo ? "Moneo audible" : "Moneo quiet");
      if (trace && mic !== micOn) trace(mic ? "mic loud" : "mic quiet");
      moneoOn = moneo; micOn = mic;
      if (controller.answering !== talking) { talking = !talking; render(); }
    }, 100);
    document.addEventListener("visibilitychange", lock);
    return () => {
      closed = true;
      clearInterval(meter);
      saveRecord();
      document.removeEventListener("visibilitychange", lock);
      try { if (live.channel?.readyState === "open") live.channel.send(JSON.stringify({ type: "session.close" })); } catch { sessionAlreadyClosed(); }
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
    const running = controller.running.some(task => task.requestId === requestId);
    controller.cancel(requestId);
    if (!running) return;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await fetch("/api/chat", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }) }).catch(() => null);
      if (response?.status !== 404) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    live.aborts.get(requestId)?.abort();
  }

  const [levels] = useState(() => {
    const buffer = new Uint8Array(512);
    return () => ({ mic: level(live.micLevel, buffer), moneo: level(live.moneoLevel, buffer) });
  });

  return {
    status, error: error || controller.error, muted, toggleMute, cancel, levels,
    captions: controller.captions, tasks: controller.tasks, cards: controller.cards, unsaid: controller.unsaid,
    typed: (text: string) => controller.typed(text),
    thinking: controller.running.length > 0,
    talking: controller.answering,
  };
}
