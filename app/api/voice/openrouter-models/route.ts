import { requireWorkspace } from "@/lib/auth";
import { openrouterModels } from "@/lib/ai/speech/openrouter";

export async function GET() {
  try { await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  return Response.json(await openrouterModels(), { headers: { "Cache-Control": "no-store" } });
}
