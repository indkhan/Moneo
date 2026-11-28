import { CALL_AUDIO_TYPES, CALL_LOG_HEADER, MAX_CALL_AUDIO_BYTES } from "@/lib/ai/voice-call-audio";
import { callLogSchema, MAX_RECORD_BYTES } from "@/lib/ai/voice-call-record";
import { requireWorkspace } from "@/lib/auth";
import { jsonBodyOrNull } from "@/lib/json-body";
import { logInfo } from "@/lib/log";

const MAX_BODY_BYTES = MAX_CALL_AUDIO_BYTES + MAX_RECORD_BYTES + 4096;
const invalidMultipartIsRejected = () => null;

export async function POST(request: Request) {
  if (request.headers.get(CALL_LOG_HEADER) !== "1") return new Response(null, { status: 403 });
  let workspaceId: string;
  try { workspaceId = (await requireWorkspace()).workspace.id; } catch { return new Response(null, { status: 401 }); }
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const form = await request.formData().catch(invalidMultipartIsRejected);
  const record = form?.get("record");
  if (typeof record !== "string") return new Response(null, { status: 400 });
  if (new TextEncoder().encode(record).length > MAX_RECORD_BYTES) return new Response(null, { status: 413 });
  const parsed = callLogSchema.safeParse(await jsonBodyOrNull(new Response(record)));
  if (!parsed.success) return new Response(null, { status: 400 });
  if (parsed.data.workspaceId !== workspaceId) return new Response(null, { status: 409 });

  const clip = form?.get("audio") ?? null;
  let audio: { bytes: ArrayBuffer; contentType: string } | undefined;
  if (clip !== null) {
    if (!(clip instanceof File) || clip.size === 0) return new Response(null, { status: 400 });
    if (clip.size > MAX_CALL_AUDIO_BYTES) return new Response(null, { status: 413 });
    const contentType = clip.type.split(";")[0];
    if (!CALL_AUDIO_TYPES.some(type => type === contentType)) return new Response(null, { status: 415 });
    audio = { bytes: await clip.arrayBuffer(), contentType };
  }
  const { id, conversationId, durationSeconds, transcript } = parsed.data;
  logInfo("voice", "voice.call_end", "Voice call ended", { callId: id, durationSeconds, transcript }, { workspaceId, conversationId, audio });
  return new Response(null, { status: 204 });
}
