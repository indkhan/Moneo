import { describe, expect, it } from "vitest";
import { decodeSpeechAudio, encodeWav, MAX_SPEECH_BYTES } from "./audio";

const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
const pcmBytes = new Uint8Array(samples.buffer);

describe("speech audio", () => {
  it("writes a mono 16-bit WAV that reads back to the same samples and rate", () => {
    const wav = encodeWav({ samples, sampleRate: 16000 });
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(decodeSpeechAudio("audio/wav", null, wav)).toEqual({ samples, sampleRate: 16000 });
  });
  it("reads raw PCM16 with the rate from the request", () => {
    expect(decodeSpeechAudio("audio/pcm", "24000", pcmBytes)).toEqual({ samples, sampleRate: 24000 });
    expect(decodeSpeechAudio("audio/pcm; charset=binary", "24000", pcmBytes)?.sampleRate).toBe(24000);
  });
  it("ignores a trailing odd byte instead of reading past it", () => {
    expect(decodeSpeechAudio("audio/pcm", "24000", new Uint8Array([...pcmBytes, 7]))?.samples).toEqual(samples);
  });
  it.each([
    ["no rate for raw PCM", "audio/pcm", null],
    ["a rate that is not a number", "audio/pcm", "fast"],
    ["a rate outside 8-48 kHz", "audio/pcm", "96000"],
    ["another media type", "audio/mpeg", "24000"],
    ["no media type", null, "24000"],
  ])("rejects %s", (_name, type, rate) => {
    expect(decodeSpeechAudio(type, rate, pcmBytes)).toBeNull();
  });
  it("rejects empty audio and a single stray byte", () => {
    expect(decodeSpeechAudio("audio/pcm", "24000", new Uint8Array())).toBeNull();
    expect(decodeSpeechAudio("audio/pcm", "24000", new Uint8Array([1]))).toBeNull();
  });
  it("rejects audio over the size limit", () => {
    expect(decodeSpeechAudio("audio/pcm", "24000", new Uint8Array(MAX_SPEECH_BYTES + 2))).toBeNull();
  });
  it("rejects WAV files that are not mono 16-bit PCM or have no data", () => {
    const wav = encodeWav({ samples, sampleRate: 16000 });
    const stereo = wav.slice(); new DataView(stereo.buffer).setUint16(22, 2, true);
    const eightBit = wav.slice(); new DataView(eightBit.buffer).setUint16(34, 8, true);
    expect(decodeSpeechAudio("audio/wav", null, stereo)).toBeNull();
    expect(decodeSpeechAudio("audio/wav", null, eightBit)).toBeNull();
    expect(decodeSpeechAudio("audio/wav", null, wav.subarray(0, 40))).toBeNull();
    expect(decodeSpeechAudio("audio/wav", null, pcmBytes)).toBeNull();
  });
});
