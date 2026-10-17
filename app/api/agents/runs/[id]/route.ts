import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { loadAgentRun } from "@/lib/ai/agent-state";
import { cancelAgentRun, resumeAgentRun } from "@/lib/ai/agent-dispatch";
import { service } from "@/lib/ai/agent-runtime";

async function owned(params: Promise<{ id: string }>) {
  const context = await requireWorkspace();
  const id = z.uuid().parse((await params).id);
  return { context, id };
}

/** Live state for mission control (polled while the run is active). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let target: Awaited<ReturnType<typeof owned>>;
  try { target = await owned(params); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const run = await loadAgentRun(target.context.supabase, target.context.workspace.id, target.id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json(run, { headers: { "Cache-Control": "no-store" } });
}

/** Stop or resume. Ownership is checked through RLS before the service role acts. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let target: Awaited<ReturnType<typeof owned>>;
  try { target = await owned(params); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const action = z.object({ action: z.enum(["cancel", "resume"]) }).strict().safeParse(await request.json().catch(() => null));
  if (!action.success) return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  const visible = await target.context.supabase.from("agent_runs").select("id").eq("workspace_id", target.context.workspace.id).eq("id", target.id).maybeSingle();
  if (visible.error || !visible.data) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  try {
    const status = action.data.action === "cancel" ? await cancelAgentRun(service(), target.id, target.context.workspace.id) : await resumeAgentRun(service(), target.id, target.context.workspace.id);
    return NextResponse.json({ status });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Request failed" }, { status: 503 }); }
}
