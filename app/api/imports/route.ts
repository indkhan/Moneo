import { requireWorkspace } from "@/lib/auth";

export async function GET() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  try {
    const { supabase, workspace } = context;
    const result = await supabase.from("imports")
      .select("id, filename, status, run_version, total_rows, new_rows, matched_rows, review_rows, classification_review_rows, rejected_rows, error, created_at")
      .eq("workspace_id", workspace.id).neq("status", "undone").order("created_at", { ascending: false }).limit(30);
    if (result.error) throw result.error;
    return Response.json(result.data);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not load imports" }, { status: 500 });
  }
}
