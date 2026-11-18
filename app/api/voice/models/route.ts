import path from "node:path";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { isDesktop } from "@/lib/desktop-bridge";
import { LOCAL_SPEECH_MODELS, localModel } from "@/lib/ai/speech/local-models";
import { modelDownloads } from "@/lib/ai/speech/model-download";
import { inspectFolder, localSpeechSupported, speechModelsDir } from "@/lib/ai/speech/model-store";
import { jsonBodyOrNull } from "@/lib/json-body";

const startSchema = z.object({ model: z.string().refine(id => Boolean(localModel(id)), "Unknown model") });
const noStore = { headers: { "Cache-Control": "no-store" } };

async function signedIn() {
  try { await requireWorkspace(); return true; } catch { return false; }
}

export async function GET(request: Request) {
  if (!await signedIn()) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const folder = new URL(request.url).searchParams.get("folder")?.trim();
  const models = await Promise.all(LOCAL_SPEECH_MODELS.map(async model => ({ id: model.id, status: await modelDownloads.status(model) })));
  const custom = folder ? (path.isAbsolute(folder) ? await inspectFolder(folder) : null) : undefined;
  return Response.json({
    supported: localSpeechSupported(), desktop: isDesktop(), folder: speechModelsDir(), models,
    ...(custom !== undefined && { custom: custom && { family: custom.family, dtype: custom.dtype } }),
  }, noStore);
}

export async function POST(request: Request) {
  if (!await signedIn()) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const input = startSchema.safeParse(await jsonBodyOrNull(request));
  if (!input.success) return Response.json({ error: "Choose one of the suggested models" }, { status: 400 });
  const model = localModel(input.data.model)!;
  void modelDownloads.start(model);
  return Response.json({ id: model.id, status: await modelDownloads.status(model) }, { status: 202, ...noStore });
}
