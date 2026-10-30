/** A live recording: `stop` waits for the final transcript, `cancel` throws everything away. */
export type VoiceRecording = { stop: () => Promise<string>; cancel: () => void };
export type VoiceHandlers = { onText: (text: string) => void; onLevel: (level: number) => void; onError: (error: Error) => void };

const RATE = 24000;
// Plain checks instead of zod: this file loads on every page with a mic, and zod would add ~90 KB to them.
type RealtimeEvent = { type: string; item_id?: string; delta?: string; transcript?: string; error?: { message?: string } };
const str = (value: unknown) => typeof value === "string" ? value : undefined;
function realtimeEvent(data: unknown): RealtimeEvent | null {
  try {
    const event = JSON.parse(String(data));
    if (typeof event?.type !== "string") return null;
    return { type: event.type, item_id: str(event.item_id), delta: str(event.delta), transcript: str(event.transcript), error: { message: str(event.error?.message) } };
  } catch { return null; }
}

/** Mono float samples at any rate to 16-bit PCM at 24 kHz, base64 encoded, as the realtime API takes them. */
export function pcm16Base64(samples: Float32Array, sampleRate: number) {
  const length = Math.round(samples.length * RATE / sampleRate);
  const pcm = new Int16Array(length);
  for (let index = 0; index < length; index++) {
    const position = index * sampleRate / RATE, before = Math.floor(position);
    const value = samples[before] + ((samples[Math.min(before + 1, samples.length - 1)] ?? 0) - samples[before]) * (position - before);
    pcm[index] = Math.max(-1, Math.min(1, value)) * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** Loudness from 0 to 1 for the level meter. */
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

/**
 * Records from the microphone and streams it to OpenAI realtime transcription with a short-lived secret
 * from `/api/voice/session`. Audio is only ever sent, never stored.
 * Call it straight from a tap: Safari grants the mic and starts audio only inside the user's gesture.
 */
export async function startVoiceRecording({ onText, onLevel, onError }: VoiceHandlers): Promise<VoiceRecording> {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.WebSocket)
    throw new Error("Voice input isn't supported in this browser.");
  // Both start before the first await, while the tap still counts as a user gesture.
  const audio = new AudioContext();
  const microphone = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const resumed = audio.resume().catch(() => {});
  let stream: MediaStream;
  try { stream = await microphone; } catch (cause) { void audio.close(); throw micError(cause); }
  const release = () => { stream.getTracks().forEach(track => track.stop()); if (audio.state !== "closed") void audio.close(); };
  try {
    // Opened without a tap (for example from a link), mobile Safari keeps audio suspended.
    await Promise.race([resumed, new Promise(resolve => setTimeout(resolve, 1000))]);
    if (audio.state !== "running") throw new Error("Tap the mic to start recording.");
  } catch (cause) { release(); throw cause; }
  // Recording starts now and is buffered while the session connects, so the first words aren't lost.
  return transcribe(audio, stream, release, openSocket(), { onText, onLevel, onError });
}

/** A realtime transcription socket, authorized with a short-lived secret from our server. */
async function openSocket() {
  const response = await fetch("/api/voice/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !str(body?.token) || !str(body?.url)) throw new Error(typeof body?.error === "string" ? body.error : "Voice input is unavailable. Try again.");
  return new WebSocket(body.url, ["realtime", `openai-insecure-api-key.${body.token}`]);
}

function transcribe(audio: AudioContext, stream: MediaStream, release: () => void, connecting: Promise<WebSocket>, { onText, onLevel, onError }: VoiceHandlers): VoiceRecording {
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
    // If Done was pressed while connecting, send what was recorded and wait for the final words.
    socket.onopen = () => settle ? commit() : flush();
    socket.onmessage = event => {
      const parsed = realtimeEvent(event.data);
      if (!parsed) return;
      const { type, item_id: id = "", delta, transcript, error } = parsed;
      if (type === "conversation.item.input_audio_transcription.delta") { items.set(id, (items.get(id) ?? "") + (delta ?? "")); onText(text()); }
      else if (type === "conversation.item.input_audio_transcription.completed") { items.set(id, transcript ?? items.get(id) ?? ""); onText(text()); settle?.(text()); }
      // After a stop, an error (such as nothing to commit) just ends with what was heard.
      else if (type === "error") { if (settle) settle(text()); else fail(new Error(error?.message ?? "Voice transcription failed.")); }
    };
    socket.onerror = () => { if (settle) settle(text()); else fail(new Error("Lost the connection to voice transcription.")); };
    socket.onclose = () => { if (settle) settle(text()); else fail(new Error("Lost the connection to voice transcription.")); };
  };

  // ScriptProcessor runs everywhere without loading a worklet module; it must reach the destination to run, so it goes through a muted gain.
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
      // Waits for the final words, but never hangs on a slow or dropped connection.
      const timer = setTimeout(() => settle?.(text()), 5000);
      // Still connecting: the socket commits once it opens.
      if (socket?.readyState === WebSocket.OPEN && (sent || waiting.length)) commit();
      else if (socket ? socket.readyState !== WebSocket.CONNECTING : !waiting.length) settle(text());
    }),
  };
}
