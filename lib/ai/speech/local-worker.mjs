import path from "node:path";
import { parentPort } from "node:worker_threads";

const SAMPLE_RATE = 16000;
const WINDOW_SECONDS = 30;
const MAX_PROMPT_TOKENS = 200;
const WHISPER_MAX_TOKENS = 448;

let loaded = null;

async function load({ folder, dtype }) {
  const key = `${folder}\n${dtype}`;
  if (loaded?.key === key) return loaded;
  await loaded?.model.dispose();
  loaded = null;
  const { AutoModelForSpeechSeq2Seq, AutoProcessor, env } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useFSCache = false;
  env.localModelPath = `${path.dirname(folder)}${path.sep}`;
  const id = path.basename(folder);
  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(id, { local_files_only: true }),
    AutoModelForSpeechSeq2Seq.from_pretrained(id, { local_files_only: true, dtype, device: "cpu" }),
  ]);
  loaded = { key, processor, model, tokenizer: processor.tokenizer };
  return loaded;
}

const lastToken = output => Number(output.tolist()[0].at(-1));

async function whisper({ processor, model, tokenizer }, samples, prompt) {
  const config = model.generation_config;
  const { input_features } = await processor(samples);
  const promptIds = prompt && config.prev_sot_token_id ? tokenizer.encode(` ${prompt}`, { add_special_tokens: false }).slice(-MAX_PROMPT_TOKENS) : [];
  const start = [...(promptIds.length ? [config.prev_sot_token_id, ...promptIds] : []), config.decoder_start_token_id];
  if (config.is_multilingual) {
    const language = lastToken(await model.generate({ inputs: input_features, decoder_input_ids: start, max_new_tokens: 1 }));
    const languages = new Set(Object.values(config.lang_to_id));
    start.push(languages.has(language) ? language : config.lang_to_id["<|en|>"], config.task_to_id.transcribe);
  }
  start.push(config.no_timestamps_token_id);
  const output = await model.generate({ inputs: input_features, decoder_input_ids: start, max_new_tokens: WHISPER_MAX_TOKENS - start.length - 1 });
  return tokenizer.decode(output.tolist()[0].slice(start.length), { skip_special_tokens: true });
}

async function moonshine({ processor, model, tokenizer }, samples) {
  const inputs = await processor(samples);
  const output = await model.generate({ ...inputs, max_new_tokens: Math.ceil(samples.length / SAMPLE_RATE) * 6 + 8 });
  return tokenizer.batch_decode(output, { skip_special_tokens: true })[0];
}

async function transcribe({ folder, family, dtype, samples, prompt }) {
  const runtime = await load({ folder, dtype });
  const window = SAMPLE_RATE * WINDOW_SECONDS;
  const texts = [];
  for (let offset = 0; offset < samples.length; offset += window) {
    const chunk = samples.subarray(offset, offset + window);
    texts.push(family === "whisper" ? await whisper(runtime, chunk, prompt) : await moonshine(runtime, chunk));
  }
  return texts.map(text => text.trim()).filter(Boolean).join(" ");
}

parentPort?.on("message", async ({ id, job }) => {
  try { parentPort?.postMessage({ id, text: await transcribe(job) }); }
  catch (cause) { parentPort?.postMessage({ id, error: cause instanceof Error ? cause.message : String(cause) }); }
});
