import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { localModel, type LocalSpeechModel, type ModelPrecision } from "./local-models";

export type ModelFamily = "whisper" | "moonshine";
export type ModelFolder = { folder: string; family: ModelFamily; dtype: ModelPrecision };

const ONNX_RUNTIME_PLATFORMS = ["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "darwin-arm64"];
export const localSpeechSupported = () => ONNX_RUNTIME_PLATFORMS.includes(`${process.platform}-${process.arch}`);

export const speechModelsDir = () => path.join(process.env.MONEO_DATA_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), ".data"), "speech-models");
export const modelFolder = (model: Pick<LocalSpeechModel, "id">, dir = speechModelsDir()) => path.join(dir, model.id);

const size = (file: string) => fs.stat(file).then(stat => stat.isFile() ? stat.size : -1, () => -1);

export async function isInstalled(model: LocalSpeechModel, dir = speechModelsDir()) {
  const sizes = await Promise.all(model.files.map(file => size(path.join(modelFolder(model, dir), file.path))));
  return sizes.every((bytes, index) => bytes === model.files[index].bytes);
}

const configSchema = z.object({ model_type: z.enum(["whisper", "moonshine"]) });
const SUFFIX: Record<ModelPrecision, string> = { q8: "_quantized", fp32: "", fp16: "_fp16" };
const REQUIRED = ["tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "generation_config.json"];

export async function inspectFolder(folder: string): Promise<ModelFolder | null> {
  const config = configSchema.safeParse(await fs.readFile(path.join(folder, "config.json"), "utf8").then(JSON.parse).catch(() => null));
  if (!config.success) return null;
  if ((await Promise.all(REQUIRED.map(file => size(path.join(folder, file))))).some(bytes => bytes <= 0)) return null;
  for (const dtype of Object.keys(SUFFIX) as ModelPrecision[]) {
    const parts = ["encoder_model", "decoder_model_merged"].map(part => path.join(folder, "onnx", `${part}${SUFFIX[dtype]}.onnx`));
    if ((await Promise.all(parts.map(size))).every(bytes => bytes > 0)) return { folder, family: config.data.model_type, dtype };
  }
  return null;
}

export async function resolveModel(ref: string | null, dir = speechModelsDir()): Promise<ModelFolder | null> {
  if (!ref) return null;
  const known = localModel(ref);
  if (known) return await isInstalled(known, dir) ? inspectFolder(modelFolder(known, dir)) : null;
  return path.isAbsolute(ref) ? inspectFolder(ref) : null;
}
