import { requireWorkspace } from "@/lib/auth";
import { z } from "zod";
import { jsonBodyOrNull } from "@/lib/json-body";
import { serviceDb } from "@/lib/service-db";

const tokens = z.number().int().nonnegative();
const voiceUsage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tokens"), id: z.uuid(), input: tokens, output: tokens, cached: tokens }).strict(),
  z.object({ kind: z.literal("audio"), id: z.uuid(), seconds: z.number().min(0).max(86_400) }).strict(),
]);

export async function PATCH(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const usage = voiceUsage.safeParse(await jsonBodyOrNull(request));
  if (!usage.success) return Response.json({ error: "Invalid voice usage" }, { status: 400 });
  const data = usage.data;
  const table = serviceDb().from("ai_usage");
  const update = data.kind === "audio"
    ? table.update({ audio_seconds: data.seconds }).or(`audio_seconds.is.null,audio_seconds.lte.${data.seconds}`)
    : table.update({ input_tokens: data.input, output_tokens: data.output, cached_input_tokens: data.cached })
      .or(`input_tokens.is.null,input_tokens.lte.${data.input}`)
      .or(`output_tokens.is.null,output_tokens.lte.${data.output}`)
      .or(`cached_input_tokens.is.null,cached_input_tokens.lte.${data.cached}`);
  const { error } = await update.eq("id", data.id).eq("workspace_id", context.workspace.id)
    .eq("source", "openai").eq("status", "succeeded").in("task", ["voice_realtime", "voice_transcription"]);
  if (error) throw error;
  return new Response(null, { status: 204 });
}
