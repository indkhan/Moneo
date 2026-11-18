import { createHash } from "node:crypto";
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalSpeechModel } from "./local-models";
import { createModelDownloads } from "./model-download";

const weights = new Uint8Array(Array.from({ length: 5000 }, (_, index) => index % 251));
const config = new TextEncoder().encode('{"model_type":"whisper"}');
const gitSha1 = (bytes: Uint8Array) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const model: LocalSpeechModel = {
  id: "whisper-base", name: "Whisper Base", languages: "Many", speed: "Fast", repo: "owner/model", revision: "abc123", dtype: "q8",
  files: [
    { path: "config.json", bytes: config.length, gitSha1: gitSha1(config) },
    { path: "onnx/encoder_model_quantized.onnx", bytes: weights.length, sha256: createHash("sha256").update(weights).digest("hex") },
  ],
};
const served: Record<string, Uint8Array> = {
  "https://huggingface.co/owner/model/resolve/abc123/config.json": config,
  "https://huggingface.co/owner/model/resolve/abc123/onnx/encoder_model_quantized.onnx": weights,
};

let dir: string;
const folder = () => path.join(dir, "whisper-base");
const fetcher = vi.fn(async (url: string, init: RequestInit) => {
  const body = served[url];
  if (!body) return new Response(null, { status: 404 });
  const range = /^bytes=(\d+)-$/.exec(new Headers(init.headers).get("Range") ?? "");
  return range ? new Response(body.slice(Number(range[1])), { status: 206 }) : new Response(body.slice());
});
const downloads = () => createModelDownloads({ dir: () => dir, fetcher });

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "moneo-models-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); fetcher.mockClear(); served["https://huggingface.co/owner/model/resolve/abc123/onnx/encoder_model_quantized.onnx"] = weights; });

it("downloads every file of the pinned revision and then reports the model installed", async () => {
  const manager = downloads();
  expect(await manager.status(model)).toEqual({ state: "missing" });
  await manager.start(model);
  expect(await manager.status(model)).toEqual({ state: "installed" });
  expect(new Uint8Array(await fs.readFile(path.join(folder(), "onnx/encoder_model_quantized.onnx")))).toEqual(weights);
  expect(await fs.readFile(path.join(folder(), "config.json"), "utf8")).toBe('{"model_type":"whisper"}');
});

it("resumes a half-finished file from where it stopped", async () => {
  await fs.mkdir(path.join(folder(), "onnx"), { recursive: true });
  await fs.writeFile(path.join(folder(), "onnx/encoder_model_quantized.onnx.part"), weights.subarray(0, 3000));
  const manager = downloads();
  await manager.start(model);
  const weightsCall = fetcher.mock.calls.find(([url]) => url.endsWith(".onnx"))!;
  expect(new Headers(weightsCall[1].headers).get("Range")).toBe("bytes=3000-");
  expect(await manager.status(model)).toEqual({ state: "installed" });
  expect(new Uint8Array(await fs.readFile(path.join(folder(), "onnx/encoder_model_quantized.onnx")))).toEqual(weights);
});

it("starts the file again when the server ignores the resume request", async () => {
  await fs.mkdir(path.join(folder(), "onnx"), { recursive: true });
  await fs.writeFile(path.join(folder(), "onnx/encoder_model_quantized.onnx.part"), weights.subarray(0, 3000));
  fetcher.mockImplementationOnce(async (url: string) => new Response(served[url].slice()));
  fetcher.mockImplementationOnce(async (url: string) => new Response(served[url].slice()));
  await downloads().start(model);
  expect(new Uint8Array(await fs.readFile(path.join(folder(), "onnx/encoder_model_quantized.onnx")))).toEqual(weights);
});

it("refuses a file whose contents do not match the pinned hash and never installs it", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  served["https://huggingface.co/owner/model/resolve/abc123/onnx/encoder_model_quantized.onnx"] = weights.map(byte => byte ^ 1);
  const manager = downloads();
  await manager.start(model);
  expect(await manager.status(model)).toMatchObject({ state: "failed", error: expect.stringContaining("did not match") });
  await expect(fs.stat(path.join(folder(), "onnx/encoder_model_quantized.onnx"))).rejects.toThrow();
  await expect(fs.stat(path.join(folder(), "onnx/encoder_model_quantized.onnx.part"))).rejects.toThrow();
});

it("runs one download per model however often it is started, and shows progress meanwhile", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fetcher.mockImplementationOnce(async (url: string) => { await gate; return new Response(served[url].slice()); });
  const manager = downloads();
  const first = manager.start(model), second = manager.start(model);
  expect(second).toBe(first);
  expect(await manager.status(model)).toEqual({ state: "downloading", received: 0, total: config.length + weights.length });
  release();
  await first;
  expect(fetcher).toHaveBeenCalledTimes(2);
});
