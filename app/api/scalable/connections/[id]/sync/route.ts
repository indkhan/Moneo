import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { ScalableError } from "@/lib/scalable/client";
import { scalableConfigured } from "@/lib/scalable/server";
import { syncScalable } from "@/lib/scalable/sync";

export const maxDuration = 60;

// "Sync now": a handful of MCP reads and one database call, so it runs inline.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!scalableConfigured()) return NextResponse.json({ error: "Scalable is not configured" }, { status: 503 });
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const connection = await context.supabase.from("scalable_connections").select("status, last_synced_at").eq("id", id.data).eq("workspace_id", context.workspace.id).maybeSingle();
  if (connection.error || !connection.data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (connection.data.status !== "active") return NextResponse.json({ error: "Connect Scalable again before syncing" }, { status: 409 });
  if (connection.data.last_synced_at && Date.now() - Date.parse(connection.data.last_synced_at) < 30_000)
    return NextResponse.json({ error: "Synced moments ago. Try again in a minute." }, { status: 429 });
  try {
    const { changed } = await syncScalable(id.data, context.workspace.id);
    return NextResponse.json({ status: "synced", changed });
  } catch (error) {
    if (error instanceof ScalableError && error.expired) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: "The Scalable sync failed. Try again." }, { status: 502 });
  }
}
