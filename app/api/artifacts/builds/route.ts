import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { loadArtifactBuilds } from "@/lib/ai/artifact-builds";

/** The builds the artifact pages list, for the cheap status check that decides when a page needs to refresh. */
export async function GET(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const artifact = z.uuid().safeParse(new URL(request.url).searchParams.get("artifact") ?? undefined);
  return Response.json({ builds: await loadArtifactBuilds(context.supabase, context.workspace.id, artifact.success ? artifact.data : undefined) }, { headers: { "Cache-Control": "no-store" } });
}
