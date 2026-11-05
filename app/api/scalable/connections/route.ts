import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { scalableConfigured } from "@/lib/scalable/server";

// Scalable connections for the UI. RLS plus the column grant keep the sealed tokens out of reach.
export async function GET() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const { data, error } = await context.supabase.from("scalable_connections").select("id, status, last_synced_at, last_error, created_at")
    .eq("workspace_id", context.workspace.id).in("status", ["active", "expired", "error"]).order("created_at", { ascending: false }).limit(1);
  if (error) return NextResponse.json({ error: "Scalable status is unavailable" }, { status: 500 });
  return NextResponse.json({ configured: scalableConfigured(), connection: data[0] ?? null });
}
