import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireWorkspace } from "@/lib/auth";
import { loadConversationHistory } from "@/lib/ai/conversation-history";

export async function GET(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Workspace unavailable" }, { status: 401 }); }
  const params = new URL(request.url).searchParams;
  const key = `moneo-conversation-${context.workspace.id}`;
  const requested = params.get("conversation") ?? (await cookies()).get(key)?.value;
  try {
    return NextResponse.json({ ...await loadConversationHistory(context.supabase, context.workspace.id, requested, params.get("threadsBefore") ?? undefined, params.get("messagesBefore") ?? undefined), selectionKey: key }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return NextResponse.json({ selectionKey: key, error: cause instanceof Error ? cause.message : "Could not load conversation" }, { status: 400 });
  }
}
