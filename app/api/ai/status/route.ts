import { requireWorkspace } from "@/lib/auth";
import { aiConfigured, voiceApiKey } from "@/lib/ai/configured";
import { currentModelId, modelConnections } from "@/lib/ai/provider";
import { modelOptions } from "@/lib/ai/model-options";

export async function GET() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const [ai, voice, connections, chatModel, artifactModel] = await Promise.all([aiConfigured(), voiceApiKey(), modelConnections(), currentModelId(context.settings, "chat"), currentModelId(context.settings, "artifacts")]);
  return Response.json({ ai, voice: Boolean(voice), models: modelOptions(connections), chatModel, artifactModel }, { headers: { "Cache-Control": "no-store" } });
}
