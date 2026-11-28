import { createLiveWords, type InterimTranscriber } from "./speech/live-words";
import { voiceUsageReporter } from "./voice-usage";

export type VoiceRecording = { stop: () => Promise<string>; cancel: () => void };
export type VoiceHandlers = { onText: (text: string) => void; onLevel: (level: number) => void; onError: (error: Error) => void; onNote: (note: string) => void };
type Microphone = { audio: AudioContext; stream: MediaStream; release: () => void };
type SessionPlan = { mode: "live"; fellBack: boolean; token: string; url: string; usageId: unknown } | { mode: "batch"; fellBack: boolean; live: boolean };

const RATE = 24000;
const notRunningIsReportedBelow = () => undefined;
type RealtimeEvent = { type: string; item_id?: string; delta?: string; transcript?: string; error?: { message?: string }; usage?: unknown };
const str = (value: unknown) => typeof value === "string" ? value : undefined;
function realtimeEvent(data: unknown): RealtimeEvent | null {
  try {
    const event = JSON.parse(String(data));
    if (typeof event?.type !== "string") return null;
    return { type: event.type, item_id: str(event.item_id), delta: str(event.delta), transcript: str(event.transcript), usage: event.usage, error: { message: str(event.error?.message) } };
  } catch { return null; }
}

export function pcm16(samples: Float32Array, sampleRate: number) {
  const length = Math.round(samples.length * RATE / sampleRate);
  const pcm = new Int16Array(length);
  for (let index = 0; index < length; index++) {
    const position = index * sampleRate / RATE, before = Math.floor(position);
    const value = samples[before] + ((samples[Math.min(before + 1, samples.length - 1)] ?? 0) - samples[before]) * (position - before);
    pcm[index] = Math.max(-1, Math.min(1, value)) * 0x7fff;
  }
  return pcm;
}

export function pcm16Base64(samples: Float32Array, sampleRate: number) {
  const bytes = new Uint8Array(pcm16(samples, sampleRate).buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function level(samples: Float32Array) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.min(1, Math.sqrt(sum / (samples.length || 1)) * 4);
}

function micError(cause: unknown) {
  const name = cause instanceof DOMException ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return new Error("Microphone access is blocked. Allow it in your browser settings to talk to Moneo.");
  if (name === "NotFoundError" || name === "OverconstrainedError") return new Error("No microphone found.");
  if (name === "NotReadableError") return new Error("The microphone is in use by another app.");
  return new Error("Could not start the microphone.");
}

async function openMicrophone(): Promise<Microphone> {
  const audio = new AudioContext();
  const microphone = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const resumed = audio.resume().catch(notRunningIsReportedBelow);
  let stream: MediaStream;
  try { stream = await microphone; } catch (cause) { void audio.close(); throw micError(cause); }
  const release = () => { stream.getTracks().forEach(track => track.stop()); if (audio.state !== "closed") void audio.close(); };
  try {
    await Promise.race([resumed, new Promise(resolve => setTimeout(resolve, 1000))]);
    if (audio.state !== "running") throw new Error("Tap the mic to start recording.");
  } catch (cause) { release(); throw cause; }
  return { audio, stream, release };
}

export async function startVoiceRecording(handlers: VoiceHandlers): Promise<VoiceRecording> {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.WebSocket)
    throw new Error("Voice input isn't supported in this browser.");
  const microphone = await openMicrophone();
  let plan: SessionPlan;
  try { plan = await openSession(); } catch (cause) { microphone.release(); throw cause; }
  if (plan.fellBack) handlers.onNote("Your chosen speech-to-text engine isn't available, so Moneo used OpenAI.");
  if (plan.mode === "live") return transcribe(microphone, Promise.resolve(new WebSocket(plan.url, ["realtime", `openai-insecure-api-key.${plan.token}`])), handlers, voiceUsageReporter(plan.usageId));
  return recordBatch(microphone, handlers.onLevel, async samples => {
    const body = await uploadSpeech("/api/voice/transcribe", samples);
    if (body.fellBack === true) handlers.onNote("Your chosen speech-to-text engine didn't work, so Moneo used OpenAI.");
    return body.text;
  }, plan.live ? { transcribe: interimSpeech, onText: handlers.onText } : undefined);
}

export async function startModelTrial(model: string, onLevel: (level: number) => void): Promise<VoiceRecording> {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || !window.AudioContext) throw new Error("Voice input isn't supported in this browser.");
  const microphone = await openMicrophone();
  return recordBatch(microphone, onLevel, async samples => (await uploadSpeech(`/api/voice/models/try?model=${encodeURIComponent(model)}`, samples)).text);
}

async function uploadSpeech(path: string, samples: Int16Array<ArrayBuffer>): Promise<{ text: string; fellBack?: unknown }> {
  const response = await fetch(`${path}${path.includes("?") ? "&" : "?"}rate=${RATE}`, { method: "POST", headers: { "Content-Type": "audio/pcm" }, body: samples });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body?.text !== "string") throw new Error(typeof body?.error === "string" ? body.error : "Voice input is unavailable. Try again.");
  return body;
}

const interimSpeech: InterimTranscriber = async (samples, signal) => {
  const response = await fetch(`/api/voice/interim?rate=${RATE}`, { method: "POST", headers: { "Content-Type": "audio/pcm" }, body: samples, signal });
  const body = await response.json().catch(() => ({}));
  if (response.ok && body?.busy === true) return null;
  if (!response.ok || typeof body?.text !== "string") throw new Error("Live words are unavailable");
  return body.text;
};

async function openSession(): Promise<SessionPlan> {
  const response = await fetch("/api/voice/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const body = await response.json().catch(() => ({}));
  const fellBack = body?.fellBack === true;
  if (response.ok && body?.mode === "batch") return { mode: "batch", fellBack, live: body.live === true };
  if (!response.ok || body?.mode !== "live" || !str(body?.token) || !str(body?.url)) throw new Error(typeof body?.error === "string" ? body.error : "Voice input is unavailable. Try again.");
  return { mode: "live", fellBack, token: body.token, url: body.url, usageId: body.usageId };
}

function transcribe({ audio, stream, release }: Microphone, connecting: Promise<WebSocket>, { onText, onLevel, onError }: VoiceHandlers, reportUsage: (event: unknown) => void): VoiceRecording {
  const items = new Map<string, string>();
  const text = () => [...items.values()].join(" ").replace(/\s+/g, " ").trim();
  const waiting: string[] = [];
  let socket: WebSocket | null = null, sent = 0, ended = false, settle: ((text: string) => void) | null = null;
  const append = (chunk: string) => {
    const message = JSON.stringify({ type: "input_audio_buffer.append", audio: chunk });
    if (socket?.readyState === WebSocket.OPEN) { socket.send(message); sent++; } else waiting.push(message);
  };
  const flush = () => { const queued = waiting.splice(0); queued.forEach(message => socket?.send(message)); sent += queued.length; };
  const commit = () => { flush(); socket?.send(JSON.stringify({ type: "input_audio_buffer.commit" })); };
  connecting.then(opened => {
    if (ended && !settle) { opened.close(); return; }
    socket = opened;
    listen(opened);
  }, cause => { if (settle) settle(text()); else fail(cause instanceof Error ? cause : new Error("Voice input is unavailable. Try again.")); });

  const listen = (socket: WebSocket) => {
    socket.onopen = () => settle ? commit() : flush();
    socket.onmessage = event => {
      const parsed = realtimeEvent(event.data);
      if (!parsed) return;
      const { type, item_id: id = "", delta, transcript, error } = parsed;
      if (type === "conversation.item.input_audio_transcription.delta") { items.set(id, (items.get(id) ?? "") + (delta ?? "")); onText(text()); }
      else if (type === "conversation.item.input_audio_transcription.completed") { reportUsage(parsed); items.set(id, transcript ?? items.get(id) ?? ""); onText(text()); settle?.(text()); }
      else if (type === "error") { if (settle) settle(text()); else fail(new Error(error?.message ?? "Voice transcription failed.")); }
    };
    socket.onerror = () => { if (settle) settle(text()); else fail(new Error("Lost the connection to voice transcription.")); };
    socket.onclose = () => { if (settle) settle(text()); else fail(new Error("Lost the connection to voice transcription.")); };
  };

  const source = audio.createMediaStreamSource(stream);
  const processor = audio.createScriptProcessor(4096, 1, 1);
  const mute = audio.createGain();
  mute.gain.value = 0;
  processor.onaudioprocess = event => {
    if (ended) return;
    const samples = event.inputBuffer.getChannelData(0);
    onLevel(level(samples));
    append(pcm16Base64(samples, audio.sampleRate));
  };
  source.connect(processor); processor.connect(mute); mute.connect(audio.destination);

  function end() {
    ended = true;
    processor.onaudioprocess = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
    }
    release();
  }
  function fail(error: Error) { if (ended) return; end(); onError(error); }
  return {
    cancel: () => { if (!ended) end(); },
    stop: () => new Promise<string>(resolve => {
      if (ended) return resolve(text());
      ended = true;
      stream.getTracks().forEach(track => track.stop());
      let done = false;
      settle = heard => { if (done) return; done = true; clearTimeout(timer); end(); resolve(heard); };
      const timer = setTimeout(() => settle?.(text()), 5000);
      if (socket?.readyState === WebSocket.OPEN && (sent || waiting.length)) commit();
      else if (socket ? socket.readyState !== WebSocket.CONNECTING : !waiting.length) settle(text());
    }),
  };
}

function recordBatch({ audio, stream, release }: Microphone, onLevel: (level: number) => void, upload: (samples: Int16Array<ArrayBuffer>) => Promise<string>,
  interim?: { transcribe: InterimTranscriber; onText: (text: string) => void }): VoiceRecording {
  const words = interim ? createLiveWords({ sampleRate: RATE, ...interim }) : null;
  const chunks: Int16Array[] = [];
  const source = audio.createMediaStreamSource(stream);
  const processor = audio.createScriptProcessor(4096, 1, 1);
  const mute = audio.createGain();
  mute.gain.value = 0;
  let ended = false;
  processor.onaudioprocess = event => {
    if (ended) return;
    const samples = event.inputBuffer.getChannelData(0);
    onLevel(level(samples));
    const chunk = pcm16(samples, audio.sampleRate);
    if (words) words.push(chunk); else chunks.push(chunk);
  };
  source.connect(processor); processor.connect(mute); mute.connect(audio.destination);
  const end = () => { ended = true; processor.onaudioprocess = null; words?.stop(); release(); };
  const recording = () => {
    if (words) return words.recording();
    const samples = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    chunks.reduce((offset, chunk) => { samples.set(chunk, offset); return offset + chunk.length; }, 0);
    return samples;
  };
  return {
    cancel: () => { if (!ended) end(); },
    async stop() {
      if (ended) return "";
      end();
      const samples = recording();
      return samples.length ? upload(samples) : "";
    },
  };
}
