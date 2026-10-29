import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceInput, isSpoken, VOICE_CONTEXT, type VoiceState } from "./use-voice-input";
import type { VoiceHandlers } from "./voice-recorder";

function harness({ stopWith = "spent 12.40 cash at Netto", maxSeconds = 120 } = {}) {
  const states: VoiceState[] = [];
  const finished: [string, string][] = [];
  const recording = { stop: vi.fn(async () => stopWith), cancel: vi.fn() };
  let handlers!: VoiceHandlers;
  let grant!: () => void;
  let deny!: (error: Error) => void;
  const record = vi.fn((given: VoiceHandlers) => { handlers = given; return new Promise<typeof recording>((resolve, reject) => { grant = () => resolve(recording); deny = reject; }); });
  const voice = createVoiceInput({ record, onFinish: (action, text) => finished.push([action, text]), onChange: state => states.push(state), maxSeconds, now: () => 1000 });
  return { voice, record, recording, states, finished, get handlers() { return handlers; }, grant: () => grant(), deny: (error: Error) => deny(error) };
}
const recordingNow = async (h: ReturnType<typeof harness>) => { const started = h.voice.start(); h.grant(); await started; };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("voice input state machine", () => {
  it("goes idle → starting → recording with live words and level", async () => {
    const h = harness();
    const started = h.voice.start();
    expect(h.voice.state.status).toBe("starting");
    h.grant(); await started;
    expect(h.voice.state).toMatchObject({ status: "recording", startedAt: 1000 });
    h.handlers.onText("spent 12");
    h.handlers.onLevel(0.4);
    expect(h.voice.state).toMatchObject({ text: "spent 12", level: 0.4 });
  });

  it("Send stops, waits for the final transcript and sends it", async () => {
    const h = harness();
    await recordingNow(h);
    h.handlers.onText("spent 12.40 cash");
    const sending = h.voice.send();
    expect(h.voice.state.status).toBe("finishing");
    await sending;
    expect(h.recording.stop).toHaveBeenCalledOnce();
    expect(h.finished).toEqual([["send", "spent 12.40 cash at Netto"]]);
    expect(h.voice.state).toMatchObject({ status: "idle", text: "", error: "" });
  });

  it("Done hands the transcript to the input instead of sending", async () => {
    const h = harness();
    await recordingNow(h);
    await h.voice.done();
    expect(h.finished).toEqual([["done", "spent 12.40 cash at Netto"]]);
  });

  it("falls back to the live words when the final transcript is empty or the stop fails", async () => {
    const h = harness({ stopWith: "  " });
    await recordingNow(h);
    h.handlers.onText("chips and eggs");
    await h.voice.send();
    expect(h.finished).toEqual([["send", "chips and eggs"]]);
    const failing = harness();
    failing.recording.stop.mockRejectedValueOnce(new Error("closed"));
    await recordingNow(failing);
    failing.handlers.onText("eggs");
    await failing.voice.done();
    expect(failing.finished).toEqual([["done", "eggs"]]);
  });

  it("sends nothing when nothing was heard", async () => {
    const h = harness({ stopWith: "" });
    await recordingNow(h);
    await h.voice.send();
    expect(h.finished).toEqual([]);
    expect(h.voice.state).toMatchObject({ status: "idle", error: "Didn't catch that. Try again." });
  });

  it("cancel discards the recording and ignores its late words", async () => {
    const h = harness();
    await recordingNow(h);
    h.handlers.onText("never mind");
    h.voice.cancel();
    expect(h.recording.cancel).toHaveBeenCalledOnce();
    expect(h.voice.state).toMatchObject({ status: "idle", text: "" });
    h.handlers.onText("late words");
    await h.voice.send();
    expect(h.voice.state.text).toBe("");
    expect(h.finished).toEqual([]);
  });

  it("cancel while the mic is starting releases it once granted", async () => {
    const h = harness();
    const started = h.voice.start();
    h.voice.cancel();
    h.grant(); await started;
    expect(h.recording.cancel).toHaveBeenCalledOnce();
    expect(h.voice.state.status).toBe("idle");
  });

  it("cancel while finishing drops the transcript", async () => {
    const h = harness();
    await recordingNow(h);
    const sending = h.voice.send();
    h.voice.cancel();
    await sending;
    expect(h.finished).toEqual([]);
  });

  it("ignores Send and Done unless recording, and a second start while busy", async () => {
    const h = harness();
    await h.voice.send(); await h.voice.done();
    const started = h.voice.start();
    void h.voice.start();
    expect(h.record).toHaveBeenCalledOnce();
    h.grant(); await started;
    expect(h.finished).toEqual([]);
  });

  it("shows a denied or unsupported mic as an error and returns to idle", async () => {
    const h = harness();
    const started = h.voice.start();
    h.deny(new Error("Microphone access is blocked. Allow it in your browser settings to talk to Moneo."));
    await started;
    expect(h.voice.state).toMatchObject({ status: "idle", error: "Microphone access is blocked. Allow it in your browser settings to talk to Moneo." });
    h.voice.cancel();
    expect(h.voice.state.error).toBe("");
  });

  it("a dropped connection keeps what was heard in the input", async () => {
    const h = harness();
    await recordingNow(h);
    h.handlers.onText("spent 5 at");
    h.handlers.onError(new Error("Lost the connection to voice transcription."));
    expect(h.recording.cancel).toHaveBeenCalledOnce();
    expect(h.finished).toEqual([["done", "spent 5 at"]]);
    expect(h.voice.state).toMatchObject({ status: "idle", error: "Lost the connection to voice transcription." });
  });

  it("stops at the length limit as Done", async () => {
    const h = harness({ maxSeconds: 120 });
    await recordingNow(h);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(h.voice.state.status).toBe("recording");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.finished).toEqual([["done", "spent 12.40 cash at Netto"]]);
  });
});

it("marks spoken messages through their context only", () => {
  expect(isSpoken(VOICE_CONTEXT)).toBe(true);
  expect(isSpoken({ path: "/" })).toBe(false);
  expect(isSpoken(null)).toBe(false);
});
