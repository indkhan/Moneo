import { start } from "workflow/api";
import { requireWorkspace } from "@/lib/auth";
import { importFile } from "@/workflows/import-file";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const { id } = await params;
  const { supabase, workspace } = context;
  const result = await supabase.from("imports").update({ status: "queued", error: null })
    .eq("id", id).eq("workspace_id", workspace.id).eq("status", "failed")
    .select("id, total_rows").maybeSingle();
  if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
  if (!result.data) return Response.json({ error: "Import is not failed or unavailable" }, { status: 409 });
  try {
    await start(importFile, [id, workspace.id, result.data.total_rows]);
    return Response.json({ importId: id, status: "queued" });
  } catch (error) {
    await supabase.from("imports").update({ status: "failed", error: String(error) })
      .eq("id", id).eq("workspace_id", workspace.id);
    return Response.json({ error: "Could not retry import" }, { status: 500 });
  }
}
