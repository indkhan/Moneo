import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const { id } = await params;
  const result = await context.supabase.from("imports")
    .select("id, filename, status, total_rows, new_rows, matched_rows, review_rows, classification_review_rows, rejected_rows, error")
    .eq("id", id).eq("workspace_id", context.workspace.id).maybeSingle();
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
  if (!result.data) return NextResponse.json({ error: "Import not found" }, { status: 404 });
  return NextResponse.json(result.data);
}
