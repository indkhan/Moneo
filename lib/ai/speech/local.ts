import type { BatchSpeechEngine, SpeechAudio, SpeechHints } from "./engine";
import { promptWithNames } from "./hints";
import { localSpeechSupported, resolveModel, type ModelFolder } from "./model-store";

const MODEL_RATE = 16000;

export type SpeechModelJob = ModelFolder & { samples: Float32Array; prompt: string };
export type SpeechModelRunner = { transcribe: (job: SpeechModelJob) => Promise<string>; idle: () => boolean };

export function modelSamples({ samples, sampleRate }: SpeechAudio) {
  const length = Math.floor(samples.length * MODEL_RATE / sampleRate);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const position = index * sampleRate / MODEL_RATE, before = Math.floor(position);
    const after = Math.min(before + 1, samples.length - 1);
    output[index] = (samples[before] + (samples[after] - samples[before]) * (position - before)) / 0x8000;
  }
  return output;
}

async function modelJob(ref: string | null, audio: SpeechAudio, hints: SpeechHints): Promise<SpeechModelJob> {
  const model = await resolveModel(ref);
  if (!model) throw new Error("The speech model is missing. Download it or choose its folder again.");
  return { ...model, samples: modelSamples(audio), prompt: promptWithNames(hints) };
}

export async function transcribeLocally(ref: string | null, runner: SpeechModelRunner, audio: SpeechAudio, hints: SpeechHints) {
  return runner.transcribe(await modelJob(ref, audio, hints));
}

async function transcribeWhenIdle(ref: string | null, runner: SpeechModelRunner, audio: SpeechAudio, hints: SpeechHints) {
  const job = await modelJob(ref, audio, hints);
  return runner.idle() ? runner.transcribe(job) : null;
}

export const localSpeech = (ref: string | null, runner: SpeechModelRunner): BatchSpeechEngine => ({
  available: async () => localSpeechSupported() && Boolean(await resolveModel(ref)),
  transcribe: (audio, hints) => transcribeLocally(ref, runner, audio, hints),
  interim: (audio, hints) => transcribeWhenIdle(ref, runner, audio, hints),
});
