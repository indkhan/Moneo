import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { level, pcm16Base64, startVoiceRecording } from "./voice-recorder";

class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static last: FakeSocket;
  readyState = FakeSocket.CONNECTING;
  sent: { type: string; audio?: string }[] = [];
  onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null; onclose: (() => void) | null = null;
  constructor(public url: string, public protocols: string[]) { FakeSocket.last = this; }
  send(message: string) { this.sent.push(JSON.parse(message)); }
  close() { this.readyState = FakeSocket.CLOSED; }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  emit(event: object) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
const audio = vi.hoisted(() => ({ state: "running", closed: 0, processor: null as null | { onaudioprocess: ((event: unknown) => void) | null } }));
class FakeAudioContext {
  sampleRate = 48000; destination = {};
  get state() { return audio.closed ? "closed" : audio.state; }
  resume() { return Promise.resolve(); }
  close() { audio.closed++; return Promise.resolve(); }
  createMediaStreamSource() { return { connect: vi.fn() }; }
  createGain() { return { gain: { value: 1 }, connect: vi.fn() }; }
  createScriptProcessor() { audio.processor = { onaudioprocess: null }; return Object.assign(audio.processor, { connect: vi.fn() }); }
}
const track = { stop: vi.fn() };
const getUserMedia = vi.fn();
const fetchMock = vi.fn();
const handlers = () => ({ onText: vi.fn(), onLevel: vi.fn(), onError: vi.fn() });
const speak = (value = 0.5) => audio.processor!.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(480).fill(value) } });

beforeEach(() => {
  audio.state = "running"; audio.closed = 0; audio.processor = null; track.stop.mockClear();
  getUserMedia.mockResolvedValue({ getTracks: () => [track] });
  fetchMock.mockResolvedValue(Response.json({ token: "ek_test", url: "wss://api.openai.com/v1/realtime?intent=transcription" }));
  vi.stubGlobal("window", { AudioContext: FakeAudioContext, WebSocket: FakeSocket });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it("converts 48 kHz float samples to 24 kHz 16-bit PCM", () => {
  const pcm = Buffer.from(pcm16Base64(new Float32Array([0, 0, 1, 1, -1, -1, 2, 2]), 48000), "base64");
  expect([...new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)]).toEqual([0, 32767, -32767, 32767]);
  expect(level(new Float32Array(4))).toBe(0);
  expect(level(new Float32Array(4).fill(1))).toBe(1);
});

it("streams audio with the short-lived secret and shows words as they arrive", async () => {
  const events = handlers();
  const recording = await startVoiceRecording(events);
  const socket = FakeSocket.last;
  expect(fetchMock).toHaveBeenCalledWith("/api/voice/session", expect.objectContaining({ method: "POST" }));
  expect(socket.protocols).toEqual(["realtime", "openai-insecure-api-key.ek_test"]);
  speak();
  expect(events.onLevel).toHaveBeenCalledWith(1);
  socket.open();
  speak();
  expect(socket.sent.map(message => message.type)).toEqual(["input_audio_buffer.append", "input_audio_buffer.append"]);
  socket.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "Spent" });
  socket.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: " twelve" });
  expect(events.onText).toHaveBeenLastCalledWith("Spent twelve");
  const stopped = recording.stop();
  expect(socket.sent.at(-1)).toEqual({ type: "input_audio_buffer.commit" });
  expect(track.stop).toHaveBeenCalled();
  socket.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "Spent 12.40 at Netto." });
  expect(await stopped).toBe("Spent 12.40 at Netto.");
  expect(socket.readyState).toBe(FakeSocket.CLOSED);
  expect(audio.closed).toBe(1);
});

it("cancel closes the mic and the connection without waiting", async () => {
  const recording = await startVoiceRecording(handlers());
  FakeSocket.last.open();
  recording.cancel();
  expect(track.stop).toHaveBeenCalled();
  expect(FakeSocket.last.readyState).toBe(FakeSocket.CLOSED);
  expect(FakeSocket.last.sent).toEqual([]);
});

it("reports a dropped connection while recording", async () => {
  const events = handlers();
  await startVoiceRecording(events);
  FakeSocket.last.open();
  FakeSocket.last.onclose?.();
  expect(events.onError).toHaveBeenCalledWith(new Error("Lost the connection to voice transcription."));
});

it("explains a blocked microphone and never asks for a session", async () => {
  getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  await expect(startVoiceRecording(handlers())).rejects.toThrow("Microphone access is blocked");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(audio.closed).toBe(1);
});

it("asks for a tap when the browser keeps audio suspended", async () => {
  vi.useFakeTimers();
  audio.state = "suspended";
  const started = startVoiceRecording(handlers());
  const failed = expect(started).rejects.toThrow("Tap the mic to start recording.");
  await vi.advanceTimersByTimeAsync(1000);
  await failed;
  expect(track.stop).toHaveBeenCalled();
  vi.useRealTimers();
});

it("passes on the session route's error and releases the mic", async () => {
  fetchMock.mockResolvedValue(Response.json({ error: "Voice input is not configured" }, { status: 503 }));
  await expect(startVoiceRecording(handlers())).rejects.toThrow("Voice input is not configured");
  expect(track.stop).toHaveBeenCalled();
});

it("says so when the browser has no microphone API", async () => {
  vi.stubGlobal("navigator", {});
  await expect(startVoiceRecording(handlers())).rejects.toThrow("Voice input isn't supported in this browser.");
});
