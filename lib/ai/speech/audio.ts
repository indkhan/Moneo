import { z } from "zod";
import type { SpeechAudio } from "./engine";

export const MAX_SPEECH_BYTES = 12 * 1024 * 1024;
const WAV_HEADER_BYTES = 44;
const RATE = z.coerce.number().int().min(8000).max(48000);
const uploadSchema = z.object({ type: z.enum(["audio/pcm", "audio/wav"]), rate: RATE.optional() });

export function encodeWav({ samples, sampleRate }: SpeechAudio) {
  const dataBytes = samples.length * 2;
  const wav = new DataView(new ArrayBuffer(WAV_HEADER_BYTES + dataBytes));
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) wav.setUint8(offset + index, value.charCodeAt(index)); };
  text(0, "RIFF"); wav.setUint32(4, 36 + dataBytes, true); text(8, "WAVE"); text(12, "fmt ");
  wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true); wav.setUint32(24, sampleRate, true);
  wav.setUint32(28, sampleRate * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); text(36, "data"); wav.setUint32(40, dataBytes, true);
  samples.forEach((sample, index) => wav.setInt16(WAV_HEADER_BYTES + index * 2, sample, true));
  return new Uint8Array(wav.buffer);
}

function pcmSamples(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength - (bytes.byteLength % 2));
  return Int16Array.from({ length: view.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true));
}

function parseWav(bytes: Uint8Array): SpeechAudio | null {
  if (bytes.byteLength < WAV_HEADER_BYTES) return null;
  const wav = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let format: { sampleRate: number } | null = null;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const size = wav.getUint32(offset + 4, true), body = offset + 8;
    if (tag(offset) === "fmt " && size >= 16) {
      const supported = wav.getUint16(body, true) === 1 && wav.getUint16(body + 2, true) === 1 && wav.getUint16(body + 14, true) === 16;
      format = supported ? { sampleRate: wav.getUint32(body + 4, true) } : null;
    } else if (tag(offset) === "data") {
      const rate = RATE.safeParse(format?.sampleRate);
      return rate.success ? { samples: pcmSamples(bytes.subarray(body, Math.min(body + size, bytes.byteLength))), sampleRate: rate.data } : null;
    }
    offset = body + size + (size % 2);
  }
  return null;
}

export function decodeSpeechAudio(contentType: string | null, rate: string | null, bytes: Uint8Array): SpeechAudio | null {
  const upload = uploadSchema.safeParse({ type: contentType?.split(";")[0].trim().toLowerCase(), rate: rate ?? undefined });
  if (!upload.success || bytes.byteLength === 0 || bytes.byteLength > MAX_SPEECH_BYTES) return null;
  if (upload.data.type === "audio/wav") return parseWav(bytes);
  const samples = pcmSamples(bytes);
  return upload.data.rate && samples.length ? { samples, sampleRate: upload.data.rate } : null;
}
