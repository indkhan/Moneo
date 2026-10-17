import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { requireAiScope } from "@/lib/settings";
import { startAgentRun } from "@/lib/ai/agent-dispatch";
import { service } from "@/lib/ai/agent-runtime";

/** Starts a manual agent-team run (or returns the one already running). */
export async function POST() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  try { requireAiScope(context.settings, "transactions"); }
  catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 403 }); }
  try { return NextResponse.json({ runId: await startAgentRun(service(), context.workspace.id) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Agent team could not start" }, { status: 503 }); }
}
