import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { scalableConfigured } from "@/lib/scalable/server";
import { jsonObject } from "@/lib/database";

export async function GET() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const { data, error } = await context.supabase.from("scalable_connections").select("id, status, last_synced_at, last_error, created_at, portfolio")
    .eq("workspace_id", context.workspace.id).in("status", ["active", "expired", "error"]).order("created_at", { ascending: false }).limit(1);
  if (error) return NextResponse.json({ error: "Scalable status is unavailable" }, { status: 500 });
  const portfolio = jsonObject.safeParse(data[0]?.portfolio);
  const connection = data[0] ? { ...data[0], portfolio: portfolio.success ? { ...portfolio.data, itemIds: undefined } : null } : null;
  return NextResponse.json({ configured: scalableConfigured(), connection });
}
