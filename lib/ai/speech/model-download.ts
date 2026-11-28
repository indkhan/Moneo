import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { LocalSpeechModel, ModelFile } from "./local-models";
import { isInstalled, modelFolder, speechModelsDir } from "./model-store";
import { logWarn } from "@/lib/log";

export type DownloadStatus =
  | { state: "missing" }
  | { state: "downloading"; received: number; total: number }
  | { state: "installed" }
  | { state: "failed"; error: string; received: number; total: number };

type Progress = { received: number; total: number; error?: string };

const fileUrl = (model: LocalSpeechModel, file: ModelFile) => `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path}`;
const size = (file: string) => fs.stat(/*turbopackIgnore: true*/ file).then(stat => stat.size, () => 0);

async function matches(file: string, expected: ModelFile) {
  if (await size(file) !== expected.bytes) return false;
  const hash = "sha256" in expected ? createHash("sha256") : createHash("sha1").update(`blob ${expected.bytes}\0`);
  for await (const chunk of createReadStream(/*turbopackIgnore: true*/ file)) hash.update(chunk as Buffer);
  return hash.digest("hex") === ("sha256" in expected ? expected.sha256 : expected.gitSha1);
}

export function createModelDownloads({ dir = speechModelsDir, fetcher = (url: string, init: RequestInit) => fetch(url, init) }: {
  dir?: () => string; fetcher?: (url: string, init: RequestInit) => Promise<Response>;
} = {}) {
  const progress = new Map<string, Progress>();
  const running = new Map<string, Promise<void>>();

  async function fetchFile(model: LocalSpeechModel, file: ModelFile, counter: Progress) {
    const target = path.join(/*turbopackIgnore: true*/ modelFolder(model, dir()), file.path), part = `${target}.part`;
    if (await size(target) === file.bytes) return;
    await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(/*turbopackIgnore: true*/ target), { recursive: true });
    let have = await size(part);
    if (have > file.bytes) { await fs.rm(/*turbopackIgnore: true*/ part, { force: true }); have = 0; }
    counter.received += have;
    if (have < file.bytes) {
      const response = await fetcher(fileUrl(model, file), { headers: have ? { Range: `bytes=${have}-` } : {}, signal: AbortSignal.timeout(30 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`The download server answered ${response.status}`);
      const resumed = have > 0 && response.status === 206;
      if (!resumed) { counter.received -= have; have = 0; }
      const handle = await fs.open(/*turbopackIgnore: true*/ part, resumed ? "a" : "w");
      try {
        for await (const chunk of Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)) { await handle.write(chunk); counter.received += (chunk as Buffer).byteLength; }
      } finally { await handle.close(); }
    }
    if (!await matches(part, file)) {
      await fs.rm(/*turbopackIgnore: true*/ part, { force: true });
      throw new Error(`${file.path} did not match the expected file. Try the download again.`);
    }
    await fs.rename(/*turbopackIgnore: true*/ part, target);
  }

  async function download(model: LocalSpeechModel) {
    const counter: Progress = { received: 0, total: model.files.reduce((total, file) => total + file.bytes, 0) };
    progress.set(model.id, counter);
    try {
      for (const file of model.files) await fetchFile(model, file, counter);
      progress.delete(model.id);
    } catch (cause) {
      counter.error = cause instanceof Error ? cause.message : "The download failed";
      logWarn("voice", "speech_model_download_failed", "[speech] model-download-failed", model.id);
    }
  }

  return {
    start(model: LocalSpeechModel) {
      const existing = running.get(model.id);
      if (existing) return existing;
      const job = download(model).finally(() => running.delete(model.id));
      running.set(model.id, job);
      return job;
    },
    async status(model: LocalSpeechModel): Promise<DownloadStatus> {
      const current = progress.get(model.id);
      if (current?.error) return { state: "failed", error: current.error, received: current.received, total: current.total };
      if (current) return { state: "downloading", received: current.received, total: current.total };
      return await isInstalled(model, dir()) ? { state: "installed" } : { state: "missing" };
    },
  };
}

export const modelDownloads = createModelDownloads();
