import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReportedUsage } from "@/lib/ai/usage";

export async function runArtifactGeneration(db: SupabaseClient, request: Request,
  input: { requestId: string; purpose: "calculator" | "proposal"; description: string; artifactId?: string },
  generate: () => Promise<{ result: Record<string, unknown>; usage: ReportedUsage | null }>) {
  const claim = await db.rpc("begin_artifact_generation", { p_request_id: input.requestId, p_purpose: input.purpose,
    p_description: input.description, p_artifact_id: input.artifactId ?? null });
  if (claim.error) return Response.json({ error: claim.error.message }, { status: claim.error.code === "P0002" ? 404 : 400 });
  if (!claim.data.started) return claim.data.status === "completed"
    ? Response.json({ ...claim.data.result, requestId: input.requestId, status: "completed" })
    : Response.json({ requestId: input.requestId, status: claim.data.status, error: claim.data.error ?? `Request is ${claim.data.status}` }, { status: 409 });
  const cancel = async () => {
    const stopped = await db.rpc("cancel_artifact_generation", { p_request_id: input.requestId });
    if (stopped.error) return Response.json({ error: stopped.error.message }, { status: 500 });
    return Response.json({ requestId: input.requestId, status: stopped.data }, { status: 409 });
  };
  if (request.signal.aborted) return cancel();
  try {
    const draft = await generate();
    if (request.signal.aborted) return cancel();
    const finished = await db.rpc("finish_artifact_generation", { p_request_id: input.requestId, p_status: "completed",
      p_result: draft.result, p_error: null, p_usage: draft.usage });
    if (finished.error) throw finished.error;
    if (finished.data !== "completed") return Response.json({ requestId: input.requestId, status: finished.data }, { status: 409 });
    return Response.json({ ...draft.result, requestId: input.requestId, status: "completed" });
  } catch (error) {
    if (request.signal.aborted) return cancel();
    const failure = (error instanceof Error ? error.message : "AI generation failed").slice(0, 2000);
    const finished = await db.rpc("finish_artifact_generation", { p_request_id: input.requestId, p_status: "failed", p_result: null, p_error: failure, p_usage: null });
    if (finished.error) return Response.json({ requestId: input.requestId, error: "Could not persist generation state" }, { status: 500 });
    return finished.data === "canceled" ? Response.json({ requestId: input.requestId, status: "canceled" }, { status: 409 })
      : Response.json({ requestId: input.requestId, status: finished.data, error: failure }, { status: 502 });
  }
}
