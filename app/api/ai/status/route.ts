import { requireWorkspace } from "@/lib/auth";
import { aiConfigured, voiceApiKey } from "@/lib/ai/configured";

/** Whether chat and voice can run, so the UI can guide the owner to Settings instead of failing. */
export async function GET() {
  try { await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const [ai, voice] = await Promise.all([aiConfigured(), voiceApiKey()]);
  return Response.json({ ai, voice: Boolean(voice) }, { headers: { "Cache-Control": "no-store" } });
}
