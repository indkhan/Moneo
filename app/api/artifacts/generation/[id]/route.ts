import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) return Response.json({ error: "Invalid generation request" }, { status: 400 });
  const receipt = await context.supabase.from("artifact_generation_requests").select("id, artifact_id, purpose, description, status, result, error, usage, created_at, updated_at")
    .eq("id", parsed.data).eq("workspace_id", context.workspace.id).maybeSingle();
  if (receipt.error) return Response.json({ error: receipt.error.message }, { status: 500 });
  return receipt.data ? Response.json(receipt.data) : Response.json({ error: "Generation request not found" }, { status: 404 });
}

export async function DELETE(_request: Request, { params }: Context) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) return Response.json({ error: "Invalid generation request" }, { status: 400 });
  const stopped = await context.supabase.rpc("cancel_artifact_generation", { p_request_id: parsed.data });
  return stopped.error ? Response.json({ error: stopped.error.message }, { status: stopped.error.code === "P0002" ? 404 : 400 }) : Response.json({ status: stopped.data });
}
