import { readFileSync } from "node:fs";
import { decodeSpeechAudio } from "../lib/ai/speech/audio";
import { SPEECH_PROMPT } from "../lib/ai/speech/hints";
import { localModel } from "../lib/ai/speech/local-models";
import { transcribeLocally } from "../lib/ai/speech/local";
import { workerRunner } from "../lib/ai/speech/local-runner";
import { modelDownloads } from "../lib/ai/speech/model-download";

const [ref, ...recordings] = process.argv.slice(2);
if (!ref || !recordings.length || !process.env.MONEO_DATA_DIR) {
  console.error("Usage: MONEO_DATA_DIR=<scratch folder> npx tsx scripts/speech-model-check.mts <model id or folder> <recording.wav>...");
  process.exit(1);
}

const model = localModel(ref);
if (model) {
  const job = modelDownloads.start(model);
  const timer = setInterval(async () => {
    const status = await modelDownloads.status(model);
    if (status.state === "downloading") console.log(`downloading ${Math.round(status.received / 1e6)} of ${Math.round(status.total / 1e6)} MB`);
  }, 5000);
  await job;
  clearInterval(timer);
  const status = await modelDownloads.status(model);
  if (status.state !== "installed") throw new Error(`Download ended as ${JSON.stringify(status)}`);
}

const hints = { prompt: SPEECH_PROMPT, keywords: ["Netto", "Girokonto", "Lebensmittel", "Revolut"] };
for (const recording of recordings) {
  const audio = decodeSpeechAudio("audio/wav", null, readFileSync(recording));
  if (!audio) throw new Error(`${recording} is not a mono 16-bit WAV`);
  const started = performance.now();
  const text = await transcribeLocally(ref, workerRunner, audio, hints);
  console.log(`${recording} (${(audio.samples.length / audio.sampleRate).toFixed(1)} s audio, ${((performance.now() - started) / 1000).toFixed(1)} s): ${text}`);
}
process.exit(0);
