import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLiveWords, LIVE_WORDS_WINDOW_SECONDS, type InterimTranscriber } from "./live-words";

const RATE = 10;
const WINDOW = RATE * LIVE_WORDS_WINDOW_SECONDS;
type Call = { samples: Int16Array; signal: AbortSignal; answer: (text: string | null) => void; fail: () => void };
let calls: Call[], shown: string[];
const transcribe: InterimTranscriber = (samples, signal) => new Promise((answer, fail) => { calls.push({ samples, signal, answer, fail: () => fail(new Error("model crashed")) }); });
const speech = (from: number, length: number) => Int16Array.from({ length }, (_, index) => from + index);
const live = () => createLiveWords({ sampleRate: RATE, transcribe, onText: text => shown.push(text) });
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { calls = []; shown = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("shows words for the growing recording every second, never asking again while one is still being transcribed", async () => {
  const words = live();
  words.push(speech(0, 10));
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls).toHaveLength(1);
  words.push(speech(10, 10));
  await vi.advanceTimersByTimeAsync(3000);
  expect(calls).toHaveLength(1);
  calls[0].answer(" spent twelve ");
  await settle();
  expect(shown).toEqual(["spent twelve"]);
  expect(calls).toHaveLength(2);
  expect(calls[1].samples).toEqual(speech(0, 20));
  calls[1].answer("spent twelve at Netto");
  await settle();
  expect(shown.at(-1)).toBe("spent twelve at Netto");
  await vi.advanceTimersByTimeAsync(5000);
  expect(calls).toHaveLength(2);
  words.push(speech(20, 10));
  await vi.advanceTimersByTimeAsync(999);
  expect(calls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toHaveLength(3);
  words.stop();
});

it("keeps the words of each full window and only re-hears the window still being spoken", async () => {
  const words = live();
  words.push(speech(0, WINDOW + 5));
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls[0].samples).toEqual(speech(0, WINDOW));
  calls[0].answer("first half");
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls[1].samples).toEqual(speech(WINDOW, 5));
  calls[1].answer("second");
  await settle();
  expect(shown).toEqual(["first half", "first half second"]);
  expect(words.recording()).toEqual(speech(0, WINDOW + 5));
  words.stop();
});

it("asks again on the next tick when the model was busy, and stops live words when the model fails", async () => {
  const words = live();
  words.push(speech(0, 10));
  await vi.advanceTimersByTimeAsync(1000);
  calls[0].answer(null);
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls).toHaveLength(2);
  expect(calls[1].samples).toEqual(speech(0, 10));
  calls[1].fail();
  words.push(speech(10, 10));
  await vi.advanceTimersByTimeAsync(5000);
  expect(calls).toHaveLength(2);
  expect(shown).toEqual([]);
  words.stop();
});

it("drops words that arrive after the recording stopped, so the final transcript wins", async () => {
  const words = live();
  words.push(speech(0, 10));
  await vi.advanceTimersByTimeAsync(1000);
  words.stop();
  expect(calls[0].signal.aborted).toBe(true);
  calls[0].answer("late interim words");
  await vi.advanceTimersByTimeAsync(5000);
  expect(shown).toEqual([]);
  expect(calls).toHaveLength(1);
});
